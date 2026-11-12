# Retomada: homologação do Fluxo Mestre da Serena (mm-sender)

Atualizado em 05/11/2026 (2ª atualização). Este arquivo não entra no instalador (`!**/*.md` no `package.json`).

## Objetivo
Gerar nova versão do instalador com o Fluxo Mestre Corporativo ativo e provar, com testes, que ele funciona e tem custo zero de execução (sem LLM, API paga ou rede).
Documento de cenários: `mm-sender\Cenários de teste para Serena.docx` (140 casos, TC001–TC140; o rodapé diz 190, o que é erro do documento).
Cópia de trabalho do docx: `.bob\tmp\cenarios_serena.docx`. Texto compacto: `..\.bob\tmp\doc_compact.txt` (na raiz do workspace `Claro`).
Critério de homologação: sucesso ≥ 95%, 0 falhas críticas, 0 falhas altas.

## Decisões do usuário
- O motor novo é o `serenaEngine.cjs`, ativado no app no lugar do `src\serenaCore.js`.
- Sem entrada de dados pela CRC. A CRC só assume o diálogo, a Serena fica silenciosa, e a CRC fecha o agendamento.
- Contador "Assumido pela CRC" no dashboard.

## Estado atual
### FEITO (confirmado em disco)
1. **Defeitos do motor corrigidos** em `serenaEngine.cjs` (13 de 14 confirmados por sondagem; o 14º, lead perdido que volta, foi refeito e passou em `probe2.js`):
   opt-out ampliado e sem falso positivo, preço ("uma média"), nome ("Meu nome é ..."), LGPD antes de ofertar horários, prompt injection genérico ("Acesso negado"), perdas com motivo, follow-up negado, renovação diária de horários, alerta à recepção em memória (`pendingReceptionAlerts`), CRC preservando contexto (`statusBeforeCrc`), perdido → engajado, `runScheduledMessages` (lembrete 24h e follow-up autorizado).
2. **Ponte** `src\serenaBridge.js` criada e ligada em `src\whatsapp.js` (texto, voz transcrita, mídia, `message_create` → CRC assume, agendador de 10 min iniciado no `ready` e parado no `disconnected`). `serenaCore` e `serenaFollowup` não são mais referenciados em `whatsapp.js`.
3. **Dashboard**: `crcDates` e `crcAssumidos` em `serenaDashboardEngine.cjs`; caixa "Assumido pela CRC" em `serena-ui-injector.html`; deduplicação de `recordLeadInbound` (mesmo texto, mesmo lead, < 3 s).
4. Harness `test-matrix-lib.js` (sandbox + guard de custo zero). Guard ficou `{"network":[],"spawn":[]}` em todas as sondagens.
5. Regressão `node test-regression.js` (S01–S30, motor ANTIGO): 30/30. Não valida o motor novo.

### RESULTADO FINAL (06/11) — matriz concluída
- `test-matrix.js` completo (TC001–TC140). Rodar: `node test-matrix.js` (ou `node test-matrix.js "TC0[0-4]\d"`; `MATRIX_JSON=arq.json` grava o detalhe).
- Resultado: **131 automatizados, 131 passaram (100%)**, 0 falhas críticas, 0 altas. Veredito: **APTO**.
- 9 casos "não implementado" (sem suporte no código): TC035, TC044, TC046, TC121, TC122, TC123, TC124, TC125, TC138. 0 não automatizáveis.
- Guard de custo zero ao fim da matriz: `{"network":[],"spawn":[]}` (nenhuma chamada de rede ou processo externo).
- Regressão `node test-regression.js` (motor antigo): todos passaram.
- `package.json`: versão **1.6.0** e exclusões no `build.files` (backups, `.bob`, `.wwebjs_cache`, `dados`, `whatsapp-sender.db`, `clinic-settings.json`, `Cenários*`, `test-matrix*.js`). Instalador NÃO gerado (só se o usuário pedir: `GERAR-INSTALADOR.bat`).
- Corrigidos nesta rodada: nome "Preciso de ajuda" (NOT_A_NAME_REGEX), origem "indicado", interesse "clarear", horário digitado vs filtro de período, "somente à noite" (NIGHT_REGEX), SLA 72h/24h grava a perda também na agenda (`syncSlaLossToAgenda`), `leads_respondidos` não conta a resposta da Serena, "uma pessoa", "tenho consulta", "alterar data", "reagendar" sem agendamento ativo, `Motivo:` no alerta de follow-up, mudança de papel ("a recepcionista").

### FALTA
1. Entregar o relatório final ao usuário (já resumido acima).
2. Opcional: gerar o instalador 1.6.0 (`GERAR-INSTALADOR.bat`) — só se o usuário pedir.
3. Pendência conhecida: homologação real depende de teste manual com WhatsApp conectado (a matriz roda no motor, não no WhatsApp Web).

## Itens sem suporte no código (classificar como "não implementado" no relatório)
TikTok e Campanha como origem, `telefone_validado`, falhas simuladas de agenda/CRM/dashboard (TC121–TC125), retry e fila, retorno após 90 dias (TC138), `followup_expirado` (TC046), taxa de conversão de follow-up (TC044), consolidação mensal.

## Custo zero (evidência até agora)
- Sem LLM nem API paga em `src\` e `serenaEngine.cjs`; `package.json` sem SDK de IA.
- Guard: 0 chamadas de rede e 0 processos externos nas sondagens. Falta rodar o guard na matriz completa.
- Downloads únicos e gratuitos: whisper.cpp (GitHub), modelo ggml-tiny (HuggingFace), HTML de versão do WhatsApp Web (raw.githubusercontent.com).
- `runtimeAutoHook` abre um servidor HTTP local em 127.0.0.1:17890 (sem custo).

## Dicas de ferramenta (aprendidas)
- `apply_diff` falha com CRLF ou `start_line` errado: use `grep` para achar a linha real.
- Um `search_and_replace` reportou sucesso mas não gravou: sempre confirme com `grep`/`read_file`.
- Arquivos grandes: `write_file` para o início e `insert_content` para o resto.

## Arquivos relevantes
- Motor novo: `serenaEngine.cjs` (~1376 linhas). Ponte: `src\serenaBridge.js`. App: `src\whatsapp.js`.
- Motor antigo (desligado): `src\serenaCore.js`, `src\serenaFollowup.js`, `src\db.js`.
- Dashboard e CRM: `configuracoes\serenaDashboardEngine.cjs`, `configuracoes\serena-ui-injector.html`.
- Anti-ban e blacklist: `configuracoes\antiBanEngine.cjs`. Hook e servidor local: `configuracoes\runtimeAutoHook.cjs`.
- Testes: `test-matrix-lib.js`, `test-regression.js`, `sim-scenarios.js`.
- Empacotamento: `package.json` (`build.files`), `GERAR-INSTALADOR.bat`.
