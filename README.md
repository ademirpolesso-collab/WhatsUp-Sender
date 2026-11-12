# M&M Odontologia LTDA — WhatsApp Sender

Aplicação desktop para Windows que permite o envio de mensagens WhatsApp unitárias ou em blocos, com acompanhamento de status em tempo real.

---

## Requisitos

| Software | Versão mínima | Download |
|---|---|---|
| Node.js | 18 LTS | https://nodejs.org |
| Git (opcional) | — | https://git-scm.com |

> **Não é necessário servidor, nem conta Business, nem token pago.**
> Basta ter um número WhatsApp comum e escanear o QR Code.

---

## Instalação (primeira vez)

```bash
# 1. Entre na pasta do projeto
cd whatsapp-sender

# 2. Instale as dependências
npm install

# 3. Inicie a aplicação
npm start
```

Na primeira execução o Chromium (usado internamente pelo whatsapp-web.js) será baixado automaticamente — pode demorar alguns minutos dependendo da internet.

---

## Gerar instalador .exe para Windows

```bash
npm run build
```

O instalador ficará em `dist/WhatsApp Sender Setup x.x.x.exe`.

---

## Como usar

### 1. Conectar o WhatsApp
1. Clique em **"Conectar WhatsApp"** no Dashboard ou em Configurações
2. Escaneie o QR Code com o celular:
   - WhatsApp → Menu (⋮) → **Dispositivos conectados** → **Conectar dispositivo**
3. Aguarde o badge ficar **verde (Conectado)**

### 2. Importar contatos
- Acesse **Contatos** → **Importar CSV**
- O CSV deve ter as colunas `nome` e `telefone` (com DDD, sem formatação):

```csv
nome,telefone
João Silva,11999998888
Maria Souza,21988887777
```

- Ou adicione manualmente clicando em **"+ Novo contato"**

### 3. Criar mensagens
- Acesse **Mensagens** → **+ Nova mensagem**
- Use as variáveis `{{nome}}` e `{{telefone}}` no texto para personalização automática

### 4. Associar contatos a mensagens
- Acesse **Associações** → **+ Nova associação**
- Vincule um contato à mensagem que ele deve receber

### 5. Disparar
- Acesse **Disparar**
- Clique em **"Carregar das associações"** para carregar todos os vínculos criados
- Ou clique em **"Selecionar contatos manualmente"** para montar a fila na hora
- Configure:
  - **Mensagens por bloco**: quantas mensagens enviar antes de pausar
  - **Delay entre blocos**: quantos segundos aguardar entre cada bloco
- Clique em **Iniciar Disparo**

### 6. Acompanhar status
- Acesse **Status** para ver todos os envios com os status:
  - 🟡 **Pendente** — na fila
  - 🔵 **Enviado** — chegou ao servidor WhatsApp
  - 🟢 **Entregue** — chegou ao dispositivo do contato
  - 🟣 **Lido** — contato abriu a mensagem
  - 🟢 **Respondido** — contato enviou uma resposta

---

## Configurações disponíveis

Acesse o menu **Configurações**:

| Campo | Descrição |
|---|---|
| Número WhatsApp | Seu número com código do país (ex: 5511999998888) |
| Mensagens por bloco padrão | Padrão: 10 |
| Delay entre blocos padrão | Padrão: 60 segundos |

---

## Estrutura de arquivos

```
whatsapp-sender/
├── main.js              ← Electron main process
├── preload.js           ← Bridge IPC segura
├── package.json
├── src/
│   ├── db.js            ← Banco SQLite local
│   ├── whatsapp.js      ← Integração whatsapp-web.js
│   ├── scheduler.js     ← Envio por blocos com delay
│   └── ipcHandlers.js   ← Handlers IPC
└── ui/
    ├── index.html       ← Interface principal
    ├── style.css        ← Tema verde M&M Odontologia
    └── app.js           ← Lógica do frontend
```

Os dados (banco SQLite + sessão WhatsApp) são salvos em:
```
C:\Users\<usuário>\AppData\Roaming\whatsapp-sender\
```

---

## Observações importantes

- Mantenha o aplicativo aberto durante o disparo
- Evite enviar muitas mensagens em sequência sem delay para não ser bloqueado pelo WhatsApp
- Recomendado: blocos de 10 a 20 mensagens com delay de 60 a 120 segundos
- A sessão WhatsApp é salva localmente — não é necessário escanear o QR Code novamente após o primeiro acesso (exceto se desconectar manualmente)
