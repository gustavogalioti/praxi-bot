// v3
require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || "praxi_jwt_secret_change_in_production";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "gustavowolkerz@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MONGODB_URI = process.env.MONGODB_URI;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const PIX_KEY = "e05184c4-76ef-4a6c-8465-6a1068ee5765";
const CADASTRO_URL = "https://gustavogalioti.github.io/praxi-site/";
const PRECO_MEDICO = 200;
const PRECO_CONSULTORIO_BASE = 300;
const PRECO_CONSULTORIO_POR_PROF = 150;

// ─── MongoDB ──────────────────────────────────────────────────────────────────

let db;
let patientsCol, clientsCol, sessionsCol, insightsCol, agendaCol, comprovantesCol;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("praxi");
  patientsCol    = db.collection("patients");
  clientsCol     = db.collection("clients");
  sessionsCol    = db.collection("sessions");
  insightsCol    = db.collection("insights");
  agendaCol      = db.collection("agenda");
  comprovantesCol = db.collection("comprovantes");
  console.log("MongoDB conectado");
}

// ─── Email via Resend ─────────────────────────────────────────────────────────

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log("RESEND_API_KEY nao configurada, email nao enviado"); return; }
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Praxi <noreply@praxibot.com.br>", to, subject, html }),
    });
  } catch (err) {
    console.error("Erro ao enviar email:", err.message);
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessions = {};

async function getSession(senderId) {
  if (!sessions[senderId]) {
    const saved = await sessionsCol.findOne({ senderId });
    sessions[senderId] = saved || { senderId, step: "inicio", profile: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
  return sessions[senderId];
}

async function saveSession(session) {
  await sessionsCol.updateOne({ senderId: session.senderId }, { $set: session }, { upsert: true });
}

async function clearSession(senderId) {
  delete sessions[senderId];
  await sessionsCol.deleteOne({ senderId });
}

// ─── Agenda ───────────────────────────────────────────────────────────────────

function parseDataHora(texto) {
  // Tenta extrair data e hora do texto livre do usuário
  // Aceita formatos: "dia 20 de junho às 14h", "20/06 14:00", "segunda às 10h", etc.
  const meses = { janeiro:1, fevereiro:2, marco:3, marco:3, abril:4, maio:5, junho:6, julho:7, agosto:8, setembro:9, outubro:10, novembro:11, dezembro:12 };
  const diasSemana = { segunda:1, terca:2, quarta:3, quinta:4, sexta:5, sabado:6, domingo:0 };

  const t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");

  // Formato DD/MM às HH:MM ou DD/MM HHh
  let m = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(?:as\s+)?(\d{1,2})(?::(\d{2}))?h?/);
  if (m) {
    const ano = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    const dt = new Date(ano, parseInt(m[2])-1, parseInt(m[1]), parseInt(m[4]), m[5]?parseInt(m[5]):0);
    if (!isNaN(dt.getTime())) return dt;
  }

  // Formato "dia X de mes às HH"
  m = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+(?:as\s+)?(\d{1,2})(?::(\d{2}))?h?/);
  if (m && meses[m[2]]) {
    const dt = new Date(new Date().getFullYear(), meses[m[2]]-1, parseInt(m[1]), parseInt(m[3]), m[4]?parseInt(m[4]):0);
    if (!isNaN(dt.getTime())) return dt;
  }

  return null;
}

async function verificarAgenda(dataHora) {
  // Por ora: verifica se já existe consulta nesse horário
  const inicio = new Date(dataHora);
  const fim = new Date(dataHora.getTime() + 60*60*1000); // +1h
  const conflito = await agendaCol.findOne({
    dataHora: { $gte: inicio, $lt: fim },
    status: { $ne: "cancelada" }
  });
  return !conflito; // true = disponível
}

async function agendarConsulta(paciente, dataHora) {
  const consulta = {
    pacienteId: paciente.id,
    pacienteNome: paciente.name,
    pacienteEmail: paciente.email,
    dataHora: dataHora,
    dataLabel: dataHora.toLocaleDateString("pt-BR", { weekday:"long", day:"numeric", month:"long", year:"numeric" }) + " as " + dataHora.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
    status: "confirmada",
    criadoEm: new Date().toISOString(),
  };
  await agendaCol.insertOne(consulta);
  return consulta;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAfirmativo(input) {
  return /^(sim|s|yes|quero|ok|pode|vamos|confirmo|aceito|claro|afirmativo|fiz|paguei|pago|tenho|ja|já)/i.test(input.trim());
}

function isNegativo(input) {
  return /^(nao|não|n|no|nenhum|nenhuma)/i.test(input.trim());
}

function parseFicha(texto) {
  // Tenta extrair campos de uma mensagem em bloco
  const profile = {};
  const linhas = texto.split(/\n/);
  for (const linha of linhas) {
    const l = linha.toLowerCase();
    if (l.includes("nome") || (!Object.keys(profile).length && linha.trim().length > 3)) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val) profile.name = val;
    }
    if (l.includes("nascimento") || l.includes("data")) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val) profile.dob = val;
    }
    if (l.includes("cidade") || l.includes("mora")) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val) profile.city = val;
    }
    if (l.includes("email") || l.includes("e-mail")) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val && val.includes("@")) profile.email = val;
    }
    if (l.includes("medicamento") || l.includes("remedio") || l.includes("remédio")) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val) profile.medications = val;
    }
    if (l.includes("objetivo") || l.includes("consulta") || l.includes("motivo")) {
      const val = linha.replace(/^.*?:\s*/,"").trim();
      if (val) profile.objetivo = val;
    }
  }
  return profile;
}

// ─── Mensagens ────────────────────────────────────────────────────────────────

function msgInicio() {
  return "Ola! Sou o *Praxi*, assistente clinico inteligente.\n\nComo posso te ajudar hoje?\n\n*1.* Marcar uma consulta\n*2.* Marcar um retorno\n*3.* Conhecer e contratar o Praxi\n\nResponda com *1*, *2* ou *3*.";
}

function msgBoasVindas(nome) {
  return "Ola, *" + nome + "*! Que bom ter voce de volta. Como posso te ajudar?\n\n*1.* Marcar uma consulta\n*2.* Marcar um retorno\n*3.* Conhecer e contratar o Praxi\n\nResponda com *1*, *2* ou *3*.";
}

function msgFicha() {
  return "Para eu criar sua ficha, preciso de algumas informacoes. Por favor, responda em uma unica mensagem neste formato:\n\n*Nome completo:*\n*Data de nascimento:* (DD/MM/AAAA)\n*Cidade:*\n*Email:*\n*Medicamentos que toma:* (ou \"nenhum\")\n*Objetivo da consulta:*";
}

function msgApresentacaoPraxi() {
  return "O Praxi e um assistente de IA que trabalha para voce — medico ou clinica — automatizando atendimento, triagem de pacientes e agendamento direto pelo WhatsApp.\n\nTemos dois perfis:\n\n*1. Perfil Medico* — Para quem atua de forma independente.\nR$ " + PRECO_MEDICO + "/mes\n\n*2. Perfil Consultorio* — Para consultorios com multiplos profissionais.\nA partir de R$ " + (PRECO_CONSULTORIO_BASE + PRECO_CONSULTORIO_POR_PROF) + "/mes\n\nQual se encaixa para voce? Responda *1* ou *2*.";
}

function msgPerfilMedico() {
  return "Perfil Medico — R$ " + PRECO_MEDICO + "/mes\n\nSou o seu assistente pessoal. Veja o que faco por voce:\n\nRecebo e triagem pacientes pelo WhatsApp 24h\nFaco o cadastro completo de cada paciente automaticamente\nGerencio sua agenda sem conflitos de horario\nGero insights clinicos com IA para apoiar suas decisoes\nVoce tem um painel completo com todos os dados\n\nSou o assistente que nunca falta e trabalha enquanto voce dorme.\n\n*Deseja seguir para me contratar?*\nResponda *sim* para continuar.";
}

function msgPerfilConsultorio() {
  return "Perfil Consultorio\n\nR$ " + PRECO_CONSULTORIO_BASE + "/mes (conta oficial)\n+ R$ " + PRECO_CONSULTORIO_POR_PROF + "/mes por profissional\n\nO Praxi gerencia toda a sua equipe:\n\nUm assistente para cada profissional\nRecepcao centralizada com triagem inteligente\nAgenda individual por profissional sem conflitos\nPainel administrativo com visao geral\n\n*Deseja seguir para me contratar?*\nResponda *sim* para continuar.";
}

function msgPix(perfil) {
  const valor = perfil === "medico" ? "R$ " + PRECO_MEDICO + ",00" : "R$ " + (PRECO_CONSULTORIO_BASE + PRECO_CONSULTORIO_POR_PROF) + ",00 (1 profissional)";
  return "Dados para pagamento via PIX\n\n*Valor:* " + valor + "\n*Chave PIX:* " + PIX_KEY + "\n\nApos realizar o pagamento, envie aqui o *comprovante* (print ou PDF). Nossa equipe ira confirmar e liberar seu acesso.";
}

// ─── Engine de conversa ───────────────────────────────────────────────────────

async function processMessage(senderId, text, messageType, mediaId) {
  const session = await getSession(senderId);
  const input = text ? text.trim() : "";
  const low = input.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  let reply = "";

  // Comandos globais
  if (low === "reiniciar" || low === "menu" || low === "inicio") {
    await clearSession(senderId);
    const fresh = await getSession(senderId);
    fresh.step = "inicio";
    await saveSession(fresh);
    return { reply: msgInicio(), session: fresh };
  }

  switch (session.step) {

    // ── TELA INICIAL ──────────────────────────────────────────────────────────
    case "inicio": {
      // Verifica se o número já tem cadastro
      const existente = await patientsCol.findOne({ phone: senderId });
      if (existente) {
        session.paciente = existente;
        reply = msgBoasVindas(existente.name.split(" ")[0]);
        session.step = "menu_retorno";
      } else {
        reply = msgInicio();
        session.step = "menu_novo";
      }
      break;
    }

    // ── MENU USUARIO NOVO ─────────────────────────────────────────────────────
    case "menu_novo":
      if (low.includes("1") || low.includes("consulta")) {
        reply = msgFicha();
        session.step = "consulta_ficha";
      } else if (low.includes("2") || low.includes("retorno")) {
        reply = "Para marcar um retorno preciso primeiro do seu cadastro.\n\n" + msgFicha();
        session.step = "consulta_ficha";
        session.tipoAgendamento = "retorno";
      } else if (low.includes("3") || low.includes("contratar") || low.includes("praxi")) {
        reply = msgApresentacaoPraxi();
        session.step = "venda_apresentacao";
      } else {
        reply = "Por favor, responda com *1*, *2* ou *3*.\n\n" + msgInicio();
      }
      break;

    // ── MENU USUARIO JA CADASTRADO ────────────────────────────────────────────
    case "menu_retorno":
      if (low.includes("1") || low.includes("consulta")) {
        session.tipoAgendamento = "consulta";
        reply = "Qual data e horario seria bom para voce?\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        session.step = "consulta_data";
      } else if (low.includes("2") || low.includes("retorno")) {
        session.tipoAgendamento = "retorno";
        reply = "Qual data e horario seria bom para o seu retorno?\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        session.step = "consulta_data";
      } else if (low.includes("3") || low.includes("contratar") || low.includes("praxi")) {
        reply = msgApresentacaoPraxi();
        session.step = "venda_apresentacao";
      } else {
        reply = "Por favor, responda com *1*, *2* ou *3*.\n\n" + msgBoasVindas(session.paciente.name.split(" ")[0]);
      }
      break;

    // ── COLETA DE FICHA EM BLOCO ──────────────────────────────────────────────
    case "consulta_ficha": {
      const ficha = parseFicha(input);
      const temCampos = ficha.name && ficha.dob && ficha.city && ficha.email;

      if (!temCampos) {
        reply = "Nao consegui identificar todos os campos. Por favor, responda no formato:\n\n" + msgFicha();
        break;
      }

      session.profile = ficha;
      reply = "Ficha criada! Se tiver algum exame que queira adiantar para o medico, pode enviar aqui.\n\nVoce tem algum exame para enviar?";
      session.step = "consulta_exames";
      break;
    }

    // ── EXAMES ────────────────────────────────────────────────────────────────
    case "consulta_exames":
      if (isAfirmativo(input)) {
        reply = "Pode enviar! Aceito imagens ou PDFs.";
        session.step = "consulta_aguardando_exame";
      } else if (isNegativo(input) || !input) {
        reply = "Tudo bem! Qual data e horario seria bom para voce?\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        session.step = "consulta_data";
      } else {
        reply = "Voce tem algum exame para enviar? Responda *sim* ou *nao*.";
      }
      break;

    case "consulta_aguardando_exame":
      if (messageType === "image" || messageType === "document") {
        // Salva referência do exame na sessão
        if (!session.exames) session.exames = [];
        session.exames.push({ mediaId: mediaId, tipo: messageType, recebidoEm: new Date().toISOString() });
        reply = "Exame recebido! Deseja enviar mais algum?\n\nResponda *sim* para enviar outro ou *nao* para continuar.";
        session.step = "consulta_mais_exames";
      } else if (isNegativo(input)) {
        reply = "Tudo bem! Qual data e horario seria bom para voce?\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        session.step = "consulta_data";
      } else {
        reply = "Pode enviar a imagem ou PDF do exame diretamente aqui.";
      }
      break;

    case "consulta_mais_exames":
      if (isAfirmativo(input) || messageType === "image" || messageType === "document") {
        if (messageType === "image" || messageType === "document") {
          if (!session.exames) session.exames = [];
          session.exames.push({ mediaId: mediaId, tipo: messageType, recebidoEm: new Date().toISOString() });
          reply = "Recebido! Mais algum?\n\nResponda *sim* ou *nao*.";
        } else {
          reply = "Pode enviar o proximo exame.";
          session.step = "consulta_aguardando_exame";
        }
      } else {
        reply = "Otimo! Qual data e horario seria bom para voce?\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        session.step = "consulta_data";
      }
      break;

    // ── DATA E HORARIO ────────────────────────────────────────────────────────
    case "consulta_data": {
      const dataHora = parseDataHora(input);

      if (!dataHora || dataHora < new Date()) {
        reply = "Nao consegui identificar a data e horario. Por favor, tente novamente.\n\n(Ex: \"dia 20 de junho as 14h\" ou \"20/06 14:00\")";
        break;
      }

      const disponivel = await verificarAgenda(dataHora);

      if (!disponivel) {
        reply = "A agenda nao esta disponivel em *" + dataHora.toLocaleDateString("pt-BR", { weekday:"long", day:"numeric", month:"long" }) + " as " + dataHora.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }) + "*.\n\nPor favor, sugira outra data e horario.";
        break;
      }

      session.dataHoraConsulta = dataHora.toISOString();

      // Cria/atualiza paciente no banco
      let paciente = await patientsCol.findOne({ phone: senderId });
      if (!paciente) {
        const count = await patientsCol.countDocuments();
        const newId = "p" + String(count + 1).padStart(3, "0");
        paciente = {
          id: newId,
          name: session.profile.name,
          dob: session.profile.dob,
          city: session.profile.city,
          email: session.profile.email,
          medications: session.profile.medications || "nenhum",
          objetivo: session.profile.objetivo || "",
          exames: session.exames || [],
          phone: senderId,
          registeredAt: new Date().toISOString(),
          source: "whatsapp",
        };
        await patientsCol.insertOne(paciente);
      } else {
        // Atualiza exames se tiver novos
        if (session.exames && session.exames.length) {
          await patientsCol.updateOne({ phone: senderId }, { $push: { exames: { $each: session.exames } } });
        }
      }
      session.paciente = paciente;

      // Agenda a consulta
      const consulta = await agendarConsulta(paciente, dataHora);
      session.consulta = consulta;

      // Envia emails de confirmação
      const dataLabel = consulta.dataLabel;
      await sendEmail(
        paciente.email,
        "Consulta confirmada — Praxi",
        "<h2>Sua consulta esta confirmada!</h2><p>Ola, <b>" + paciente.name + "</b>!</p><p>Sua consulta foi agendada para <b>" + dataLabel + "</b>.</p><p>Ate logo!</p>"
      );
      await sendEmail(
        ADMIN_EMAIL,
        "Nova consulta agendada — " + paciente.name,
        "<h2>Nova consulta agendada</h2><p><b>Paciente:</b> " + paciente.name + "</p><p><b>Data:</b> " + dataLabel + "</p><p><b>Email:</b> " + paciente.email + "</p><p><b>Objetivo:</b> " + (paciente.objetivo || "-") + "</p>"
      );

      reply = "Consulta confirmada!\n\n*" + dataLabel + "*\n\nVoce e o medico receberam a confirmacao por email.\n\nPosso ajudar com mais alguma coisa?";
      session.step = "completo";
      break;
    }

    // ── FLUXO VENDA ───────────────────────────────────────────────────────────
    case "venda_apresentacao":
      if (low.includes("1") || low.includes("medico") || low.includes("solo") || low.includes("sozinho")) {
        reply = msgPerfilMedico();
        session.vendaPerfil = "medico";
        session.step = "venda_detalhe";
      } else if (low.includes("2") || low.includes("consultorio") || low.includes("clinica")) {
        reply = msgPerfilConsultorio();
        session.vendaPerfil = "consultorio";
        session.step = "venda_detalhe";
      } else {
        reply = "Por favor, responda *1* para Perfil Medico ou *2* para Perfil Consultorio.\n\n" + msgApresentacaoPraxi();
      }
      break;

    case "venda_detalhe":
      if (isAfirmativo(input) || low.includes("contratar") || low.includes("seguir")) {
        reply = "Otima escolha!\n\nPara finalizar sua contratacao:\n\n*1.* Acesse o link e preencha seu cadastro:\n" + CADASTRO_URL + "\n\n*2.* Apos preencher, volte aqui e me avise para eu te passar os dados de pagamento.";
        session.step = "venda_aguardando_cadastro";
      } else if (isNegativo(input) || low.includes("voltar")) {
        reply = msgApresentacaoPraxi();
        session.step = "venda_apresentacao";
      } else {
        reply = "Deseja seguir para me contratar? Responda *sim* para continuar ou *nao* para voltar.";
      }
      break;

    case "venda_aguardando_cadastro":
      if (low.includes("cadastr") || low.includes("preenchi") || low.includes("conclu") || isAfirmativo(input)) {
        reply = msgPix(session.vendaPerfil);
        session.step = "venda_aguardando_comprovante";
      } else {
        reply = "Quando finalizar o cadastro no link abaixo, me avise aqui:\n" + CADASTRO_URL;
      }
      break;

    case "venda_aguardando_comprovante":
      if (messageType === "image" || messageType === "document") {
        // Salva comprovante
        await comprovantesCol.insertOne({
          senderId: senderId,
          mediaId: mediaId,
          tipo: messageType,
          perfil: session.vendaPerfil,
          status: "pendente",
          recebidoEm: new Date().toISOString(),
        });

        // Notifica admin
        await sendEmail(
          ADMIN_EMAIL,
          "Novo comprovante de pagamento recebido — Praxi",
          "<h2>Novo comprovante recebido</h2><p><b>Numero:</b> " + senderId + "</p><p><b>Perfil:</b> " + session.vendaPerfil + "</p><p>Acesse o painel para aprovar o cliente.</p>"
        );

        reply = "Comprovante recebido! Aguarde enquanto nossa equipe confirma o pagamento e libera seu acesso. Em breve entraremos em contato.\n\nObrigado por escolher o Praxi!";
        session.step = "completo";
      } else if (isAfirmativo(input) || low.includes("paguei") || low.includes("pago")) {
        reply = "Por favor, envie aqui o *comprovante de pagamento* (print ou PDF) para nossa equipe confirmar.";
      } else {
        reply = msgPix(session.vendaPerfil) + "\n\nApos pagar, envie o comprovante aqui (print ou PDF).";
      }
      break;

    case "completo":
      reply = "Posso ajudar com mais alguma coisa? Digite *menu* para voltar ao inicio.";
      break;

    default:
      reply = msgInicio();
      session.step = "menu_novo";
  }

  session.updatedAt = new Date().toISOString();
  await saveSession(session);
  return { reply, session };
}

// ─── Anthropic helper ─────────────────────────────────────────────────────────

var SYSTEM_PROMPT = "Voce e o Praxi Bot, assistente de apoio a decisao clinica. Forneca insights concisos baseados em evidencias. Sempre lembre que nao substitui o julgamento medico profissional.";

async function generateInsight(prompt, patientId, context) {
  const userMessage = context ? "Contexto:\n" + context + "\n\n" + prompt : prompt;
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const responseText = message.content[0].type === "text" ? message.content[0].text : "";
  const record = { id: "ins_" + Date.now(), patientId: patientId || null, prompt, context: context || null, response: responseText, model: message.model, createdAt: new Date().toISOString() };
  await insightsCol.insertOne(record);
  return record;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function verifyJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "Token ausente" });
  try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch (err) { return res.status(401).json({ error: "Token invalido" }); }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito ao admin" });
  next();
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get("/api/healthz", function(_req, res) { res.json({ status: "ok", db: db ? "conectado" : "desconectado" }); });

app.get("/webhook", function(req, res) {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    res.status(403).json({ error: "Token invalido" });
  }
});

app.post("/webhook", async function(req, res) {
  res.status(200).send("OK");
  const body = req.body;
  if (!body.object) return;
  const entry = body.entry && body.entry[0];
  const change = entry && entry.changes && entry.changes[0];
  const value = change && change.value;
  const message = value && value.messages && value.messages[0];
  if (!message) return;

  const from = message.from;
  const messageType = message.type; // text, image, document, audio, etc.
  const text = (message.text && message.text.body) || "";
  const mediaId = (message.image && message.image.id) || (message.document && message.document.id) || null;

  const result = await processMessage(from, text, messageType, mediaId);
  const reply = result.reply;

  try {
    await fetch("https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/messages", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: from, type: "text", text: { body: reply } }),
    });
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.message);
  }
});

// Sessions
app.get("/api/webhook/sessions", async function(_req, res) {
  const all = await sessionsCol.find({}).toArray();
  res.json({ sessions: all, total: all.length });
});

// Patients
app.get("/api/patients", async function(_req, res) {
  const all = await patientsCol.find({}).toArray();
  res.json({ patients: all, total: all.length });
});

app.get("/api/patients/:id", async function(req, res) {
  const patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Paciente nao encontrado" });
  res.json(patient);
});

app.post("/api/patients", async function(req, res) {
  const body = req.body;
  const missing = ["name", "dob", "city", "email", "medications"].filter(function(f) { return !body[f]; });
  if (missing.length) return res.status(400).json({ error: "Campos obrigatorios ausentes", missing });
  const count = await patientsCol.countDocuments();
  const id = "p" + String(count + 1).padStart(3, "0");
  const patient = { id, name: body.name, dob: body.dob, city: body.city, email: body.email, medications: body.medications, diagnosis: body.diagnosis, appointment: body.appointment, registeredAt: new Date().toISOString(), source: "manual" };
  await patientsCol.insertOne(patient);
  res.status(201).json(patient);
});

app.post("/api/patients/:id/insight", async function(req, res) {
  const patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Paciente nao encontrado" });
  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: "prompt e obrigatorio" });
  const context = ["Nome: " + patient.name, "Nascimento: " + patient.dob, "Medicamentos: " + patient.medications, patient.diagnosis ? "Diagnostico: " + patient.diagnosis : null].filter(Boolean).join("\n");
  try {
    const record = await generateInsight(prompt, patient.id, context);
    res.json({ patient, insight: record });
  } catch (err) {
    res.status(502).json({ error: "Erro Anthropic", detail: err.message });
  }
});

// Agenda
app.get("/api/agenda", async function(_req, res) {
  const all = await agendaCol.find({}).sort({ dataHora: 1 }).toArray();
  res.json({ agenda: all, total: all.length });
});

// Comprovantes pendentes (admin)
app.get("/api/admin/comprovantes", verifyJWT, adminOnly, async function(_req, res) {
  const all = await comprovantesCol.find({ status: "pendente" }).toArray();
  res.json({ comprovantes: all, total: all.length });
});

app.patch("/api/admin/comprovantes/:id", verifyJWT, adminOnly, async function(req, res) {
  const { MongoClient: MC, ObjectId } = require("mongodb");
  const status = req.body.status;
  await comprovantesCol.updateOne({ _id: new (require("mongodb").ObjectId)(req.params.id) }, { $set: { status } });
  res.json({ ok: true });
});

// Auth
app.post("/api/auth/register", async function(req, res) {
  const body = req.body;
  if (!body.name || !body.email || !body.password) return res.status(400).json({ error: "name, email e password obrigatorios" });
  const existing = await clientsCol.findOne({ email: body.email });
  if (existing) return res.status(409).json({ error: "Email ja cadastrado" });
  const passwordHash = await bcrypt.hash(body.password, 10);
  const id = "cl_" + Date.now();
  const nextBilling = new Date(); nextBilling.setDate(nextBilling.getDate() + 30);
  const client = { id, name: body.name, email: body.email, passwordHash, type: body.type || "solo", crm: body.crm || null, specialty: body.specialty || null, phone: body.phone || null, createdAt: new Date().toISOString(), status: "pending", plan: body.plan || "free", nextBilling: nextBilling.toISOString() };
  await clientsCol.insertOne(client);
  const safe = Object.assign({}, client); delete safe.passwordHash;
  res.status(201).json(safe);
});

app.post("/api/auth/login", async function(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email e password obrigatorios" });
  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    return res.json({ token: jwt.sign({ role: "admin", email }, JWT_SECRET, { expiresIn: "8h" }), role: "admin", expiresIn: "8h" });
  }
  const client = await clientsCol.findOne({ email });
  if (!client) return res.status(401).json({ error: "Credenciais invalidas" });
  const valid = await bcrypt.compare(password, client.passwordHash);
  if (!valid) return res.status(401).json({ error: "Credenciais invalidas" });
  if (client.status === "suspended") return res.status(403).json({ error: "Conta suspensa" });
  const token = jwt.sign({ role: "client", id: client.id, email }, JWT_SECRET, { expiresIn: "8h" });
  const safe = Object.assign({}, client); delete safe.passwordHash;
  res.json({ token, role: "client", expiresIn: "8h", client: safe });
});

app.get("/api/clients/me", verifyJWT, async function(req, res) {
  if (req.user.role !== "client") return res.status(403).json({ error: "Rota apenas para clientes" });
  const client = await clientsCol.findOne({ id: req.user.id });
  if (!client) return res.status(404).json({ error: "Cliente nao encontrado" });
  const safe = Object.assign({}, client); delete safe.passwordHash;
  res.json(safe);
});

app.patch("/api/clients/me", verifyJWT, async function(req, res) {
  if (req.user.role !== "client") return res.status(403).json({ error: "Rota apenas para clientes" });
  const allowed = ["name", "phone", "specialty", "crm"];
  const updates = {};
  allowed.forEach(function(f) { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: "Nenhum campo valido" });
  await clientsCol.updateOne({ id: req.user.id }, { $set: updates });
  const client = await clientsCol.findOne({ id: req.user.id });
  const safe = Object.assign({}, client); delete safe.passwordHash;
  res.json({ updated: Object.keys(updates), client: safe });
});

app.get("/api/admin/clients", verifyJWT, adminOnly, async function(_req, res) {
  const all = await clientsCol.find({}).toArray();
  res.json({ clients: all.map(function(c) { const s = Object.assign({}, c); delete s.passwordHash; return s; }), total: all.length });
});

app.patch("/api/admin/clients/:id", verifyJWT, adminOnly, async function(req, res) {
  const updates = {};
  if (req.body.email !== undefined) updates.email = req.body.email;
  if (req.body.plan !== undefined) updates.plan = req.body.plan;
  if (req.body.status !== undefined) updates.status = req.body.status;
  await clientsCol.updateOne({ id: req.params.id }, { $set: updates });
  const client = await clientsCol.findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Cliente nao encontrado" });

  // Se aprovado, envia email de boas vindas
  if (req.body.status === "active") {
    await sendEmail(
      client.email,
      "Bem-vindo ao Praxi!",
      "<h2>Sua conta foi aprovada!</h2><p>Ola, <b>" + client.name + "</b>! Sua conta Praxi esta ativa.</p><p>Acesse a plataforma e configure seu assistente.</p><p>Em breve nossa equipe entrara em contato para acompanhar seus primeiros passos.</p>"
    );
  }

  const safe = Object.assign({}, client); delete safe.passwordHash;
  res.json(safe);
});

app.delete("/api/admin/clients/:id", verifyJWT, adminOnly, async function(req, res) {
  await clientsCol.updateOne({ id: req.params.id }, { $set: { status: "suspended" } });
  res.json({ message: "Cliente suspenso" });
});

app.get("/api/register-phone", async function(_req, res) {
  try {
    const response = await fetch("https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/register", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: "000000" }),
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

connectDB().then(function() {
  app.listen(PORT, function() { console.log("Praxi Bot running on port " + PORT); });
}).catch(function(err) {
  console.error("Falha ao conectar MongoDB:", err);
  process.exit(1);
});
