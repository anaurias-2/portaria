# Backlog do Projeto - Sistema de Controle de Ponto (Pizzaria)

Este arquivo registra continuamente todas as funcionalidades implementadas, corrigidas ou alteradas no sistema de ponto da pizzaria.

---

## 📌 Registros de Alterações

### [Versão 1.0.0] - Implementação Completa
- [x] **Criação do arquivo de registro `backlog.md`**: Estrutura inicial e controle incremental de tarefas.
- [x] **Modelagem de Banco de Dados (`schema.sql`)**:
  - Tabelas de `jornadas_trabalho`, `funcionarios`, `status_caixa`, `entregas_em_andamento`, `registros_ponto` e `ocorrencias`.
  - Dados de Seed para os cargos exigidos: Cozinha (Pizzaiolo), Entregadores (Motoboy), Caixa e Atendente.
- [x] **Interface e Experiência do Usuário (HTML5/CSS3 Vanilla)**:
  - Layout Clean UI (`#FFFFFF`), responsivo com foco em Tablets e Desktop.
  - Uso estrito de ícones vetoriais **Lucide Icons** via CDN (sem emojis na interface).
  - Componentes de navegação entre Totem Tablet e Painel Gerencial.
- [x] **Integracão Supabase e APIs do Sistema (`app.js`)**:
  - Inicialização do cliente Supabase via CDN com fallback para motor local em memória.
  - Implementação do endpoint `POST /ponto/registrar`:
    - Validação de tolerância na entrada por cargo (5 minutos para Cozinha, 10 minutos para demais).
    - Disparo automático de ocorrência/alerta no painel do gerente em caso de atraso na Cozinha.
    - Regra de virada de meia-noite (`data_referencia_turno`) vinculando a saída à data de entrada do turno.
    - Condicionamento de saída de Caixa e Atendimento ao fechamento do caixa no sistema, com suporte a Override Gerencial e `SAIDA_FORCADA_EMERGENCIA`.
    - Classificação automática de `HORA_EXTRA_ENTREGA` para motoboys com entregas pendentes.
    - Geração de hash único de comprovante para cada batida.
  - Implementação do endpoint `GET /ponto/comprovante/:hash`: Validação de autenticidade de tickets emitidos.
  - Implementação do endpoint `POST /ocorrencias/justificar`: Registro e anexação de comprovantes/atestados de ausências ou saídas forçadas.
  - Implementação do endpoint `GET /funcionarios/:id/espelho`: Exibição consolidada do histórico de batidas e inconsistências.
- [x] **Recursos Nativos**:
  - Câmera (`navigator.mediaDevices.getUserMedia`) para validação e captura facial no tablet.
  - Geolocalização (`navigator.geolocation`) para validação de raio (Geofencing) no aplicativo.
