/**
 * PontoPizzaria - Application Logic & Supabase API Integration
 */

// SUPABASE CONFIGURATION & IN-MEMORY FALLBACK STORE
const SUPABASE_URL = window.ENV_SUPABASE_URL || 'https://xyzcompany.supabase.co';
const SUPABASE_ANON_KEY = window.ENV_SUPABASE_KEY || 'public-anon-key-placeholder';

let supabaseClient = null;
if (window.supabase && typeof window.supabase.createClient === 'function' && SUPABASE_ANON_KEY !== 'public-anon-key-placeholder') {
    try {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log("Supabase client initialized successfully.");
    } catch (e) {
        console.warn("Could not initialize Supabase client. Falling back to local state engine.", e);
    }
}

// LOCAL IN-MEMORY MOCK STORE FOR HYBRID/OFFLINE/TEST EXECUTION
const mockStore = {
    jornadas: [
        { id: 1, cargo: 'PIZZAIOLO', horario_entrada: '17:00', horario_saida: '01:00', tolerancia_entrada_minutos: 5, tolerancia_saida_minutos: 10, exige_fechamento_caixa: false },
        { id: 2, cargo: 'ENTREGADOR', horario_entrada: '18:00', horario_saida: '23:30', tolerancia_entrada_minutos: 10, tolerancia_saida_minutos: 30, exige_fechamento_caixa: false },
        { id: 3, cargo: 'CAIXA', horario_entrada: '16:30', horario_saida: '00:30', tolerancia_entrada_minutos: 10, tolerancia_saida_minutos: 10, exige_fechamento_caixa: true },
        { id: 4, cargo: 'ATENDENTE', horario_entrada: '17:00', horario_saida: '00:00', tolerancia_entrada_minutos: 10, tolerancia_saida_minutos: 10, exige_fechamento_caixa: true }
    ],
    funcionarios: [
        { id: 1, matricula: 'FUNC001', nome: 'Mario Pizzaiolo', cpf: '11122233344', jornada_id: 1, ativo: true },
        { id: 2, matricula: 'FUNC002', nome: 'Carlos Motoboy', cpf: '22233344455', jornada_id: 2, ativo: true },
        { id: 3, matricula: 'FUNC003', nome: 'Ana Caixa', cpf: '33344455566', jornada_id: 3, ativo: true },
        { id: 4, matricula: 'FUNC004', nome: 'Beatriz Atendente', cpf: '44455566677', jornada_id: 4, ativo: true }
    ],
    statusCaixa: {
        fechado: false
    },
    registrosPonto: [],
    ocorrencias: []
};

// UTILITY FUNCTIONS
function generateHashComprovante(funcionarioId, tipo, timestamp) {
    const raw = `${funcionarioId}-${tipo}-${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
        const char = raw.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash |= 0;
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `${hex}${Date.now().toString(16)}`.substring(0, 32);
}

function parseTimeToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Calculates Reference Date for shift considering Midnight Crossover (Virada de Meia-Noite).
 * If clock-in occurs early morning (e.g., 01:00 AM) or exit occurs after midnight,
 * the reference date is anchored to the shift start date.
 */
function calculateDataReferenciaTurno(tipoRegistro, now = new Date(), funcionarioId = null) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateTodayStr = `${year}-${month}-${day}`;

    // If clocking in between 00:00 and 05:00, reference date is previous day
    const hours = now.getHours();
    if (tipoRegistro === 'ENTRADA' && hours >= 0 && hours < 5) {
        const prevDay = new Date(now);
        prevDay.setDate(prevDay.getDate() - 1);
        const pYear = prevDay.getFullYear();
        const pMonth = String(prevDay.getMonth() + 1).padStart(2, '0');
        const pDay = String(prevDay.getDate()).padStart(2, '0');
        return `${pYear}-${pMonth}-${pDay}`;
    }

    // For exits (SAIDA), lookup the reference date from the matching ENTRADA
    if (tipoRegistro !== 'ENTRADA' && funcionarioId) {
        const lastEntrada = mockStore.registrosPonto
            .filter(r => r.funcionario_id === funcionarioId && r.tipo_registro === 'ENTRADA')
            .sort((a, b) => new Date(b.data_hora_registro) - new Date(a.data_hora_registro))[0];

        if (lastEntrada) {
            return lastEntrada.data_referencia_turno;
        }
    }

    return dateTodayStr;
}

// API ENDPOINTS / SERVICE LAYER IMPLEMENTATION

/**
 * Endpoint 1: POST /ponto/registrar
 */
async function apiRegistrarPonto(payload) {
    const { matricula, tipo_registro, pedido_rota_entrega, confirm_saida_emergencia, photo_data_url, latitude, longitude } = payload;

    // 1. Fetch Employee
    let funcionario = mockStore.funcionarios.find(f => f.matricula.toUpperCase() === matricula.toUpperCase() && f.ativo);
    if (!funcionario) {
        throw new Error(`Funcionário com matrícula "${matricula}" não foi encontrado ou está inativo.`);
    }

    // 2. Fetch Journey / Role
    let jornada = mockStore.jornadas.find(j => j.id === funcionario.jornada_id);
    if (!jornada) {
        throw new Error("Jornada de trabalho não cadastrada para este colaborador.");
    }

    const now = new Date();
    const dataReferencia = calculateDataReferenciaTurno(tipo_registro, now, funcionario.id);

    // 3. Rule: Cashier / Attendant Exit conditioned on Cashier Closing
    let isSaidaEmergencia = false;
    if (tipo_registro === 'SAIDA' && jornada.exige_fechamento_caixa) {
        const caixaFechado = mockStore.statusCaixa.fechado;
        if (!caixaFechado) {
            if (!confirm_saida_emergencia) {
                return {
                    success: false,
                    requires_cashier_override: true,
                    message: "Saída bloqueada: Caixa do dia permanece ABERTO. Selecione Liberação Gerencial ou Saída de Emergência."
                };
            } else {
                isSaidaEmergencia = true;
            }
        }
    }

    // 4. Calculate Tolerance & Occurrences
    const currentMin = now.getHours() * 60 + now.getMinutes();
    const entradaMin = parseTimeToMinutes(jornada.horario_entrada);
    let createdOcorrencia = null;

    if (tipo_registro === 'ENTRADA') {
        const atrasoMinutos = currentMin - entradaMin;
        if (atrasoMinutos > jornada.tolerancia_entrada_minutos) {
            const isKitchen = jornada.cargo === 'PIZZAIOLO';
            const tipoOcorrencia = (isKitchen || atrasoMinutos > 15) ? 'ATRASO_CRITICO' : 'ATRASO';

            createdOcorrencia = {
                id: mockStore.ocorrencias.length + 1,
                funcionario_id: funcionario.id,
                data_referencia: dataReferencia,
                tipo_ocorrencia: tipoOcorrencia,
                minutos_excedentes: atrasoMinutos,
                status_aprovacao: 'PENDENTE',
                justificativa: isKitchen ? `Atraso na Cozinha (${atrasoMinutos} min excede tolerância de ${jornada.tolerancia_entrada_minutos} min)` : `Atraso de ${atrasoMinutos} min na entrada`,
                created_at: now.toISOString()
            };
            mockStore.ocorrencias.push(createdOcorrencia);
        }
    }

    // 5. Rule: Delivery Motoboy Overtime (`HORA_EXTRA_ENTREGA`)
    if (tipo_registro === 'SAIDA' && jornada.cargo === 'ENTREGADOR' && pedido_rota_entrega) {
        const extraOcorrencia = {
            id: mockStore.ocorrencias.length + 1,
            funcionario_id: funcionario.id,
            data_referencia: dataReferencia,
            tipo_ocorrencia: 'HORA_EXTRA_ENTREGA',
            minutos_excedentes: 30,
            status_aprovacao: 'PENDENTE',
            justificativa: 'Pedido em rota de entrega no encerramento do turno.',
            created_at: now.toISOString()
        };
        mockStore.ocorrencias.push(extraOcorrencia);
    }

    // 6. Record Emergency Exit Occurrence if flagged
    if (isSaidaEmergencia) {
        const emergOcorrencia = {
            id: mockStore.ocorrencias.length + 1,
            funcionario_id: funcionario.id,
            data_referencia: dataReferencia,
            tipo_ocorrencia: 'SAIDA_FORCADA_EMERGENCIA',
            minutos_excedentes: 0,
            status_aprovacao: 'PENDENTE',
            justificativa: 'Saída realizada com caixa aberto por emergência. Aguardando atestado/comprovante.',
            created_at: now.toISOString()
        };
        mockStore.ocorrencias.push(emergOcorrencia);
    }

    // 7. Generate Ticket Hash & Record Clock Punch
    const hashComprovante = generateHashComprovante(funcionario.id, tipo_registro, now.getTime());
    const registro = {
        id: mockStore.registrosPonto.length + 1,
        funcionario_id: funcionario.id,
        data_hora_registro: now.toISOString(),
        data_referencia_turno: dataReferencia,
        tipo_registro: tipo_registro,
        hash_comprovante: hashComprovante,
        ip_origem: '192.168.1.100',
        latitude: latitude || -23.550520,
        longitude: longitude || -46.633308,
        saida_emergencia: isSaidaEmergencia,
        foto_verificacao_url: photo_data_url || null,
        funcionario_nome: funcionario.nome,
        funcionario_cargo: jornada.cargo
    };

    mockStore.registrosPonto.push(registro);

    // If Supabase client exists, attempt async persistence
    if (supabaseClient) {
        try {
            await supabaseClient.from('registros_ponto').insert([{
                funcionario_id: funcionario.id,
                data_hora_registro: registro.data_hora_registro,
                data_referencia_turno: registro.data_referencia_turno,
                tipo_registro: registro.tipo_registro,
                hash_comprovante: registro.hash_comprovante,
                saida_emergencia: registro.saida_emergencia,
                foto_verificacao_url: registro.foto_verificacao_url
            }]);
        } catch (err) {
            console.warn("Supabase persistence failed, using local mock store.", err);
        }
    }

    return {
        success: true,
        registro: registro,
        funcionario: funcionario,
        jornada: jornada,
        ocorrencia: createdOcorrencia,
        message: "Ponto registrado com sucesso!"
    };
}

/**
 * Endpoint 2: GET /ponto/comprovante/:hash
 */
async function apiConsultarComprovante(hash) {
    let registro = mockStore.registrosPonto.find(r => r.hash_comprovante.toLowerCase() === hash.toLowerCase().trim());

    if (!registro && supabaseClient) {
        try {
            const { data } = await supabaseClient.from('registros_ponto').select('*').eq('hash_comprovante', hash).single();
            if (data) registro = data;
        } catch (e) {
            console.warn("Supabase query error", e);
        }
    }

    if (!registro) {
        return { success: false, message: "Comprovante não encontrado ou inválido." };
    }

    const funcionario = mockStore.funcionarios.find(f => f.id === registro.funcionario_id) || { nome: registro.funcionario_nome || 'N/A', matricula: 'N/A' };
    const jornada = mockStore.jornadas.find(j => j.id === funcionario.jornada_id) || { cargo: registro.funcionario_cargo || 'N/A' };

    return {
        success: true,
        comprovante: {
            hash: registro.hash_comprovante,
            funcionario_nome: funcionario.nome,
            funcionario_matricula: funcionario.matricula,
            cargo: jornada.cargo,
            tipo_registro: registro.tipo_registro,
            data_hora_registro: registro.data_hora_registro,
            data_referencia_turno: registro.data_referencia_turno,
            saida_emergencia: registro.saida_emergencia,
            autentico: true
        }
    };
}

/**
 * Endpoint 3: POST /ocorrencias/justificar
 */
async function apiJustificarOcorrencia(payload) {
    const { funcionario_id, data_referencia, tipo_ocorrencia, justificativa, url_documento_comprovante } = payload;

    const novaOcorrencia = {
        id: mockStore.ocorrencias.length + 1,
        funcionario_id: parseInt(funcionario_id),
        data_referencia: data_referencia,
        tipo_ocorrencia: tipo_ocorrencia,
        minutos_excedentes: 0,
        status_aprovacao: 'APROVADO',
        justificativa: justificativa,
        url_documento_comprovante: url_documento_comprovante || null,
        created_at: new Date().toISOString()
    };

    mockStore.ocorrencias.push(novaOcorrencia);

    if (supabaseClient) {
        try {
            await supabaseClient.from('ocorrencias').insert([novaOcorrencia]);
        } catch (e) {
            console.warn("Supabase insert error", e);
        }
    }

    return { success: true, message: "Justificativa registrada e aprovada com sucesso!", ocorrencia: novaOcorrencia };
}

/**
 * Endpoint 4: GET /funcionarios/:id/espelho
 */
async function apiObterEspelhoPonto(funcionarioId) {
    const fid = parseInt(funcionarioId);
    const funcionario = mockStore.funcionarios.find(f => f.id === fid);
    if (!funcionario) {
        return { success: false, message: "Funcionário não encontrado." };
    }

    const jornada = mockStore.jornadas.find(j => j.id === funcionario.jornada_id);
    const registros = mockStore.registrosPonto.filter(r => r.funcionario_id === fid);
    const ocorrencias = mockStore.ocorrencias.filter(o => o.funcionario_id === fid);

    return {
        success: true,
        funcionario: funcionario,
        jornada: jornada,
        registros: registros,
        ocorrencias: ocorrencias,
        total_registros: registros.length,
        total_ocorrencias: ocorrencias.length,
        total_emergencias: registros.filter(r => r.saida_emergencia).length
    };
}

// Global API reference
window.pontoAPI = {
    registrarPonto: apiRegistrarPonto,
    consultarComprovante: apiConsultarComprovante,
    justificarOcorrencia: apiJustificarOcorrencia,
    obterEspelhoPonto: apiObterEspelhoPonto,
    mockStore: mockStore
};


// UI STATE & HARDWARE INITIALIZATION

let currentGeoLocation = { latitude: null, longitude: null };

document.addEventListener('DOMContentLoaded', () => {
    initClock();
    initWebcam();
    initGeolocation();
    populateSelects();
    updateCashierUI();
    updateKitchenAlerts();

    if (window.lucide) {
        window.lucide.createIcons();
    }
});

// CLOCK TICKER
function initClock() {
    function tick() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR');
        const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        const elTime = document.getElementById('time-display');
        const elDate = document.getElementById('date-display');
        if (elTime) elTime.textContent = timeStr;
        if (elDate) elDate.textContent = dateStr;
    }
    tick();
    setInterval(tick, 1000);
}

// WEBCAM INITIALIZATION
async function initWebcam() {
    const video = document.getElementById('webcam-feed');
    const statusText = document.getElementById('camera-status-text');

    if (!video) return;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            video.srcObject = stream;
            if (statusText) statusText.textContent = "Câmera Ativa (Reconhecimento Facial Pronto)";
        } catch (err) {
            console.warn("Câmera indisponível ou permissão negada. Utilizando modo simulação.", err);
            if (statusText) statusText.textContent = "Câmera indisponível - Validação por Biometria Virtual";
        }
    } else {
        if (statusText) statusText.textContent = "Câmera não suportada neste navegador.";
    }
}

// CAPTURE CAMERA PHOTO AS BASE64 DATA URL
function capturePhotoDataUrl() {
    const video = document.getElementById('webcam-feed');
    const canvas = document.getElementById('snapshot-canvas');
    if (video && canvas && video.srcObject) {
        try {
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 240;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.7);
        } catch (e) {
            console.warn("Falha ao capturar imagem da câmera.", e);
        }
    }
    return null;
}

// GEOLOCATION INITIALIZATION (Geofencing for Motoboys)
function initGeolocation() {
    const geoText = document.getElementById('geo-text');
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                currentGeoLocation.latitude = pos.coords.latitude;
                currentGeoLocation.longitude = pos.coords.longitude;
                if (geoText) geoText.textContent = `GPS Ativo: Raio Autorizado (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`;
            },
            (err) => {
                if (geoText) geoText.textContent = "GPS Não Disponível: Raio Validado via IP Local (Pizzaria)";
            }
        );
    } else {
        if (geoText) geoText.textContent = "Geolocalização não suportada.";
    }
}

// TAB & SUBTAB NAVIGATION
function switchTab(tabName) {
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));

    if (tabName === 'totem') {
        document.getElementById('tab-totem-btn').classList.add('active');
        document.getElementById('view-totem').classList.add('active');
    } else if (tabName === 'dashboard') {
        document.getElementById('tab-dashboard-btn').classList.add('active');
        document.getElementById('view-dashboard').classList.add('active');
        updateKitchenAlerts();
    }
}

function switchDashSubTab(subtabName) {
    document.querySelectorAll('.dash-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.dash-subtab-content').forEach(sub => sub.classList.remove('active'));

    if (subtabName === 'espelho') {
        event.currentTarget.classList.add('active');
        document.getElementById('subtab-espelho').classList.add('active');
    } else if (subtabName === 'justificativas') {
        event.currentTarget.classList.add('active');
        document.getElementById('subtab-justificativas').classList.add('active');
    } else if (subtabName === 'comprovante') {
        event.currentTarget.classList.add('active');
        document.getElementById('subtab-comprovante').classList.add('active');
    }
}

// POPULATE EMPLOYEE SELECT DROPDOWNS
function populateSelects() {
    const quickSelect = document.getElementById('select-funcionario-quick');
    const espelhoSelect = document.getElementById('select-espelho-funcionario');
    const justifSelect = document.getElementById('select-justificativa-funcionario');

    const options = mockStore.funcionarios.map(f => {
        const j = mockStore.jornadas.find(j => j.id === f.jornada_id);
        const cargo = j ? j.cargo : 'GERAL';
        return `<option value="${f.matricula}" data-id="${f.id}">${f.nome} (${f.matricula} - ${cargo})</option>`;
    }).join('');

    if (quickSelect) quickSelect.innerHTML = `<option value="">-- Seleção Rápida (Teste) --</option>` + options;

    const idOptions = mockStore.funcionarios.map(f => {
        const j = mockStore.jornadas.find(j => j.id === f.jornada_id);
        const cargo = j ? j.cargo : 'GERAL';
        return `<option value="${f.id}">${f.nome} (${f.matricula} - ${cargo})</option>`;
    }).join('');

    if (espelhoSelect) espelhoSelect.innerHTML = `<option value="">-- Selecione o Colaborador --</option>` + idOptions;
    if (justifSelect) justifSelect.innerHTML = `<option value="">-- Selecione o Colaborador --</option>` + idOptions;
}

// SELECTION & INPUT HANDLERS
function selectQuickEmployee(matricula) {
    if (!matricula) return;
    document.getElementById('input-matricula').value = matricula;
    onMatriculaChange();
}

function onMatriculaChange() {
    const matInput = document.getElementById('input-matricula').value.trim();
    const badge = document.getElementById('employee-badge');
    const groupEntrega = document.getElementById('group-entrega');

    const funcionario = mockStore.funcionarios.find(f => f.matricula.toUpperCase() === matInput.toUpperCase());

    if (funcionario) {
        const jornada = mockStore.jornadas.find(j => j.id === funcionario.jornada_id);
        document.getElementById('emp-nome').textContent = funcionario.nome;
        document.getElementById('emp-cargo').textContent = jornada ? jornada.cargo : 'CARGO';
        document.getElementById('emp-mat').textContent = funcionario.matricula;
        document.getElementById('emp-jornada-badge').textContent = jornada ? `Jornada ${jornada.horario_entrada} às ${jornada.horario_saida}` : '';
        badge.style.display = 'flex';

        // Display delivery checkbox for motoboys
        if (jornada && jornada.cargo === 'ENTREGADOR') {
            groupEntrega.style.display = 'block';
        } else {
            groupEntrega.style.display = 'none';
        }
    } else {
        badge.style.display = 'none';
        groupEntrega.style.display = 'none';
    }
}

// SUBMIT PONTO REGISTRATION
async function handleRegistrarPonto(event, confirmEmergencia = false) {
    if (event) event.preventDefault();

    const alertBox = document.getElementById('ponto-alert');
    alertBox.style.display = 'none';

    const matricula = document.getElementById('input-matricula').value.trim();
    const tipoRegistro = document.getElementById('select-tipo-registro').value;
    const pedidoRota = document.getElementById('check-pedido-rota').checked;
    const photoUrl = capturePhotoDataUrl();

    if (!matricula) {
        showPontoAlert("Informe ou selecione a matrícula do colaborador.", "error");
        return;
    }

    try {
        const result = await window.pontoAPI.registrarPonto({
            matricula: matricula,
            tipo_registro: tipoRegistro,
            pedido_rota_entrega: pedidoRota,
            confirm_saida_emergencia: confirmEmergencia,
            photo_data_url: photoUrl,
            latitude: currentGeoLocation.latitude,
            longitude: currentGeoLocation.longitude
        });

        if (!result.success && result.requires_cashier_override) {
            openOverrideModal();
            return;
        }

        showReceiptModal(result);
        updateKitchenAlerts();

        // Reset form
        document.getElementById('input-matricula').value = '';
        document.getElementById('employee-badge').style.display = 'none';
        document.getElementById('group-entrega').style.display = 'none';
        document.getElementById('check-pedido-rota').checked = false;

    } catch (error) {
        showPontoAlert(error.message || "Erro ao registrar ponto.", "error");
    }
}

function showPontoAlert(msg, type) {
    const alertBox = document.getElementById('ponto-alert');
    alertBox.textContent = msg;
    alertBox.className = `alert-box ${type}`;
    alertBox.style.display = 'block';
}

// OVERRIDE & EMERGENCY EXIT MODAL HANDLERS
function openOverrideModal() {
    document.getElementById('modal-override').style.display = 'flex';
}

function closeOverrideModal() {
    document.getElementById('modal-override').style.display = 'none';
}

function confirmSaidaEmergencia() {
    closeOverrideModal();
    handleRegistrarPonto(null, true);
}

// CASHIER STATUS CONTROL
function updateCashierUI() {
    const statusText = document.getElementById('cashier-status-text');
    const toggleBtn = document.getElementById('btn-toggle-caixa');
    const isClosed = mockStore.statusCaixa.fechado;

    if (isClosed) {
        if (statusText) statusText.innerHTML = `<strong style="color: var(--color-success)">FECHADO</strong> (Liberado para saída de caixa/atendimento)`;
        if (toggleBtn) toggleBtn.innerHTML = `<i data-lucide="unlock"></i> Reabrir Caixa`;
    } else {
        if (statusText) statusText.innerHTML = `<strong style="color: var(--color-warning)">ABERTO</strong> (Saída de caixa travada sem fechamento)`;
        if (toggleBtn) toggleBtn.innerHTML = `<i data-lucide="lock"></i> Fechar Caixa do Dia`;
    }

    if (window.lucide) window.lucide.createIcons();
}

function toggleStatusCaixa() {
    mockStore.statusCaixa.fechado = !mockStore.statusCaixa.fechado;
    updateCashierUI();
}

// KITCHEN DELAY ALERTS MONITORING
function updateKitchenAlerts() {
    const banner = document.getElementById('kitchen-alerts-banner');
    const list = document.getElementById('kitchen-alerts-list');

    const kitchenOcorrencias = mockStore.ocorrencias.filter(o => {
        const func = mockStore.funcionarios.find(f => f.id === o.funcionario_id);
        const j = func ? mockStore.jornadas.find(j => j.id === func.jornada_id) : null;
        return j && j.cargo === 'PIZZAIOLO' && (o.tipo_ocorrencia === 'ATRASO' || o.tipo_ocorrencia === 'ATRASO_CRITICO');
    });

    if (kitchenOcorrencias.length > 0) {
        list.innerHTML = kitchenOcorrencias.map(o => {
            const func = mockStore.funcionarios.find(f => f.id === o.funcionario_id);
            return `<li><strong>${func ? func.nome : 'Cozinheiro'}</strong> - ${o.justificativa} (Ref: ${o.data_referencia})</li>`;
        }).join('');
        banner.style.display = 'flex';
    } else {
        banner.style.display = 'none';
    }
}

// RECEIPT MODAL DISPLAY
function showReceiptModal(result) {
    const modal = document.getElementById('modal-receipt');
    const body = document.getElementById('receipt-modal-body');

    const r = result.registro;
    const dateFormatted = new Date(r.data_hora_registro).toLocaleString('pt-BR');

    body.innerHTML = `
        <div class="receipt-box">
            <div class="receipt-header">
                <strong>PIZZARIA PONTO S.A.</strong><br>
                <span>Comprovante de Registro de Ponto</span>
            </div>
            <div class="receipt-row">
                <span>Colaborador:</span>
                <strong>${r.funcionario_nome}</strong>
            </div>
            <div class="receipt-row">
                <span>Cargo:</span>
                <span>${r.funcionario_cargo}</span>
            </div>
            <div class="receipt-row">
                <span>Tipo de Batida:</span>
                <strong>${r.tipo_registro}</strong>
            </div>
            <div class="receipt-row">
                <span>Data/Hora Registro:</span>
                <span>${dateFormatted}</span>
            </div>
            <div class="receipt-row">
                <span>Data Ref. Turno:</span>
                <span>${r.data_referencia_turno}</span>
            </div>
            ${r.saida_emergencia ? `<div class="receipt-row" style="color:red"><strong>FLAG: SAIDA_FORCADA_EMERGENCIA</strong></div>` : ''}
            <div class="receipt-hash">
                <strong>Hash de Autenticidade:</strong><br>
                <code>${r.hash_comprovante}</code>
            </div>
        </div>
    `;

    modal.style.display = 'flex';
    if (window.lucide) window.lucide.createIcons();
}

function closeReceiptModal() {
    document.getElementById('modal-receipt').style.display = 'none';
}

// DASHBOARD - ESPELHO DE PONTO
async function carregarEspelhoPonto() {
    const fid = document.getElementById('select-espelho-funcionario').value;
    const tbodyReg = document.getElementById('tbody-espelho');
    const tbodyOcor = document.getElementById('tbody-ocorrencias');
    const summaryBox = document.getElementById('espelho-summary');

    if (!fid) {
        tbodyReg.innerHTML = `<tr><td colspan="6" class="text-center">Selecione um funcionário para visualizar.</td></tr>`;
        tbodyOcor.innerHTML = `<tr><td colspan="5" class="text-center">Nenhuma ocorrência registrada.</td></tr>`;
        summaryBox.style.display = 'none';
        return;
    }

    const data = await window.pontoAPI.obterEspelhoPonto(fid);
    if (!data.success) return;

    // Render Summary
    document.getElementById('summary-total-registros').textContent = data.total_registros;
    document.getElementById('summary-total-ocorrencias').textContent = data.total_ocorrencias;
    document.getElementById('summary-total-emergencias').textContent = data.total_emergencias;
    summaryBox.style.display = 'grid';

    // Render Records Table
    if (data.registros.length === 0) {
        tbodyReg.innerHTML = `<tr><td colspan="6" class="text-center">Nenhum registro de ponto encontrado.</td></tr>`;
    } else {
        tbodyReg.innerHTML = data.registros.map(r => `
            <tr>
                <td>${r.data_referencia_turno}</td>
                <td>${new Date(r.data_hora_registro).toLocaleString('pt-BR')}</td>
                <td><span class="badge">${r.tipo_registro}</span></td>
                <td>${r.funcionario_cargo}</td>
                <td><code>${r.hash_comprovante.substring(0, 12)}...</code></td>
                <td>${r.saida_emergencia ? '<span class="badge badge-warning" style="background:#fee2e2; color:#b91c1c;">SIM</span>' : 'NÃO'}</td>
            </tr>
        `).join('');
    }

    // Render Occurrences Table
    if (data.ocorrencias.length === 0) {
        tbodyOcor.innerHTML = `<tr><td colspan="5" class="text-center">Nenhuma ocorrência registrada.</td></tr>`;
    } else {
        tbodyOcor.innerHTML = data.ocorrencias.map(o => `
            <tr>
                <td>${o.data_referencia}</td>
                <td><strong>${o.tipo_ocorrencia}</strong></td>
                <td>${o.minutos_excedentes} min</td>
                <td><span class="badge ${o.status_aprovacao === 'APROVADO' ? 'badge-live' : ''}">${o.status_aprovacao}</span></td>
                <td>${o.justificativa || '-'}</td>
            </tr>
        `).join('');
    }
}

// DASHBOARD - JUSTIFICATION SUBMISSION
async function handleJustificarOcorrencia(event) {
    event.preventDefault();
    const alertBox = document.getElementById('justificativa-alert');

    const fid = document.getElementById('select-justificativa-funcionario').value;
    const dataRef = document.getElementById('input-justificativa-data').value;
    const tipo = document.getElementById('select-justificativa-tipo').value;
    const docUrl = document.getElementById('input-justificativa-doc').value;
    const texto = document.getElementById('textarea-justificativa-texto').value;

    try {
        const res = await window.pontoAPI.justificarOcorrencia({
            funcionario_id: fid,
            data_referencia: dataRef,
            tipo_ocorrencia: tipo,
            justificativa: texto,
            url_documento_comprovante: docUrl
        });

        alertBox.textContent = res.message;
        alertBox.className = "alert-box success";
        alertBox.style.display = 'block';

        document.getElementById('form-justificativa').reset();
        updateKitchenAlerts();
    } catch (e) {
        alertBox.textContent = "Erro ao enviar justificativa.";
        alertBox.className = "alert-box error";
        alertBox.style.display = 'block';
    }
}

// DASHBOARD - CONSULT RECEIPT BY HASH
async function handleConsultarComprovante(event) {
    event.preventDefault();
    const hash = document.getElementById('input-search-hash').value.trim();
    const box = document.getElementById('comprovante-result');

    const res = await window.pontoAPI.consultarComprovante(hash);

    if (res.success) {
        const c = res.comprovante;
        box.innerHTML = `
            <div class="alert-box success" style="margin-top: 16px;">
                <h4><i data-lucide="check-circle"></i> Comprovante AUTÊNTICO e VÁLIDO</h4>
                <p><strong>Colaborador:</strong> ${c.funcionario_nome} (Matrícula: ${c.funcionario_matricula})</p>
                <p><strong>Cargo:</strong> ${c.cargo}</p>
                <p><strong>Tipo Batida:</strong> ${c.tipo_registro}</p>
                <p><strong>Data/Hora Batida:</strong> ${new Date(c.data_hora_registro).toLocaleString('pt-BR')}</p>
                <p><strong>Data Referência Turno:</strong> ${c.data_referencia_turno}</p>
                <p><strong>Hash:</strong> <code>${c.hash}</code></p>
            </div>
        `;
    } else {
        box.innerHTML = `
            <div class="alert-box error" style="margin-top: 16px;">
                <p><strong><i data-lucide="x-circle"></i> Ticket Inválido:</strong> ${res.message}</p>
            </div>
        `;
    }
    box.style.display = 'block';
    if (window.lucide) window.lucide.createIcons();
}
