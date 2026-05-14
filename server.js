// v2
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
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const PIX_KEY = "e05184c4-76ef-4a6c-8465-6a1068ee5765";
const CADASTRO_URL = "https://gustavogalioti.github.io/praxi-site/";
const PRECO_MEDICO = 200;
const PRECO_CONSULTORIO_BASE = 300;
const PRECO_CONSULTORIO_POR_PROF = 150;

// ─── MongoDB ──────────────────────────────────────────────────────────────────

let db;
let patientsCol, clientsCol, sessionsCol, insightsCol;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("praxi");
  patientsCol = db.collection("patients");
  clientsCol  = db.collection("clients");
  sessionsCol = db.collection("sessions");
  insightsCol = db.collection("insights");
  console.log("MongoDB conectado");

  const count = await patientsCol.countDocuments();
  if (count === 0) {
    await patientsCol.insertMany([
      { id: "p001", name: "Alice Johnson", dob: "1992-03-05", city: "Sao Paulo", email: "alice@example.com", medications: "Metformina 500mg", diagnosis: "Diabetes Tipo 2", appointment: "2026-06-10", registeredAt: new Date().toISOString(), source: "manual" },
      { id: "p002", name: "Bob Martinez", dob: "1968-07-22", city: "Rio de Janeiro", email: "bob@example.com", medications: "Anlodipino 5mg", diagnosis: "Hipertensao", appointment: "2026-05-20", registeredAt: new Date().toISOString(), source: "manual" },
    ]);
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sessions = {};

async function getSession(senderId) {
  if (!sessions[senderId]) {
    const saved = await sessionsCol.findOne({ senderId });
    if (saved) {
      sessions[senderId] = saved;
    } else {
      sessions[senderId] = {
        senderId, step: "inicio", profile: {},
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    }
  }
  return sessions[senderId];
}

async function saveSession(session) {
  await sessionsCol.updateOne(
    { senderId: session.senderId },
    { $set: session },
    { upsert: true }
  );
}

// ─── Slots de agenda ──────────────────────────────────────────────────────────

function generateSlots(count) {
  count = count || 6;
  const slots = [];
  const allowedDays = [1, 2, 3, 4, 5];
  const times = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00", "17:00"];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + 1);
  while (slots.length < count) {
    if (allowedDays.includes(cursor.getDay())) {
      for (var ti = 0; ti < times.length; ti++) {
        if (slots.length >= count) break;
        var t = times[ti];
        var parts = t.split(":");
        var dt = new Date(cursor);
        dt.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
        slots.push({
          index: slots.length + 1,
          label: dt.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + " as " + t,
          isoDate: dt.toISOString().split("T")[0],
          time: t,
        });
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

// ─── Mensagens reutilizaveis ──────────────────────────────────────────────────

function msgInicio() {
  return "Ola! Sou o *Praxi*, assistente clinico inteligente.\n\nComo posso te ajudar hoje?\n\n*1.* Marcar uma consulta\n*2.* Conhecer e contratar o Praxi\n\nResponda com *1* ou *2*.";
}

function msgApresentacaoPraxi() {
  return "O Praxi e um assistente de IA que trabalha para voce — medico ou clinica — automatizando atendimento, triagem de pacientes e agendamento direto pelo WhatsApp.\n\nTemos dois perfis:\n\n*1. Perfil Medico* — Para quem atua de forma independente.\nR$ " + PRECO_MEDICO + "/mes\n\n*2. Perfil Consultorio* — Para consultórios com multiplos profissionais.\nA partir de R$ " + (PRECO_CONSULTORIO_BASE + PRECO_CONSULTORIO_POR_PROF) + "/mes\n\nQual se encaixa para voce? Responda *1* ou *2*.";
}

function msgPerfilMedico() {
  return "Perfil Medico — R$ " + PRECO_MEDICO + "/mes\n\nSou o seu assistente pessoal. Veja o que faco por voce:\n\nRecebo e triagem pacientes pelo WhatsApp 24h\nFaco o cadastro completo de cada paciente automaticamente\nGerencio sua agenda sem conflitos de horario\nGero insights clinicos com IA para apoiar suas decisoes\nVoce tem um painel completo com todos os dados\n\nSou o assistente que nunca falta, nunca erra o horario e trabalha enquanto voce dorme.\n\n*Deseja seguir para me contratar?*\nResponda *sim* para continuar.";
}

function msgPerfilConsultorio() {
  return "Perfil Consultorio\n\nR$ " + PRECO_CONSULTORIO_BASE + "/mes (conta oficial do consultorio)\n+ R$ " + PRECO_CONSULTORIO_POR_PROF + "/mes por profissional\n\nO Praxi gerencia toda a sua equipe:\n\nUm assistente dedicado para cada profissional\nRecepcao centralizada com triagem inteligente\nAgenda individual por profissional sem conflitos\nPainel administrativo do consultorio com visao geral\nCada medico acessa seus proprios dados e pacientes\n\n*Deseja seguir para me contratar?*\nResponda *sim* para continuar.";
}

function msgProcedimentoContratacao(perfil) {
  var descricao = perfil === "medico"
    ? "Perfil Medico — R$ " + PRECO_MEDICO + "/mes"
    : "Perfil Consultorio — a partir de R$ " + (PRECO_CONSULTORIO_BASE + PRECO_CONSULTORIO_POR_PROF) + "/mes";

  return "Otima escolha!\n\nPara finalizar sua contratacao — " + descricao + " — siga os passos:\n\n*1.* Acesse o link de cadastro e preencha seus dados:\n" + CADASTRO_URL + "\n\n*2.* Apos o cadastro, volte aqui e me avise. Vou te passar os dados de pagamento via PIX.\n\n*3.* Com o pagamento confirmado, voce recebe o e-mail de boas-vindas com acesso e instrucoes para ativar seu Praxi.\n\nJa fez o cadastro? Me avise aqui!";
}

function msgPix(perfil) {
  var valor = perfil === "medico"
    ? "R$ " + PRECO_MEDICO + ",00"
    : "R$ " + (PRECO_CONSULTORIO_BASE + PRECO_CONSULTORIO_POR_PROF) + ",00 (1 profissional)";

  return "Dados para pagamento via PIX\n\n*Valor:* " + valor + "\n*Chave PIX:* " + PIX_KEY + "\n\nApos realizar o pagamento, me avise aqui confirmando. Seu acesso e liberado assim que o pagamento for confirmado.";
}

function isAfirmativo(input) {
  return /^(sim|s|yes|quero|ok|pode|vamos|confirmo|aceito|claro|afirmativo|fiz|paguei|pago)/i.test(input.trim());
}

// ─── Engine de conversa ───────────────────────────────────────────────────────

async function processMessage(senderId, text) {
  const session = await getSession(senderId);
  const input = text.trim();
  const low = input.toLowerCase();
  var reply = "";

  if (low === "reiniciar" || low === "menu" || low === "inicio") {
    delete sessions[senderId];
    await sessionsCol.deleteOne({ senderId });
    const fresh = await getSession(senderId);
    fresh.step = "inicio";
    await saveSession(fresh);
    return { reply: msgInicio(), session: fresh };
  }

  switch (session.step) {

    case "inicio":
      reply = msgInicio();
      session.step = "aguardando_opcao_inicial";
      break;

    case "aguardando_opcao_inicial":
      if (low.includes("1") || low.includes("consulta") || low.includes("marcar")) {
        reply = "Vamos marcar sua consulta.\n\nQual e o seu *nome completo*?";
        session.step = "consulta_nome";
      } else if (low.includes("2") || low.includes("contratar") || low.includes("praxi")) {
        reply = msgApresentacaoPraxi();
        session.step = "venda_apresentacao";
      } else {
        reply = "Por favor, responda com *1* para marcar uma consulta ou *2* para conhecer o Praxi.\n\n" + msgInicio();
      }
      break;

    case "consulta_nome":
      if (!input) { reply = "Por favor, informe seu nome completo."; break; }
      session.profile.name = input;
      reply = "Obrigado, *" + input + "*!\n\nQual e a sua *data de nascimento*? (ex: DD/MM/AAAA)";
      session.step = "consulta_dob";
      break;

    case "consulta_dob":
      if (!input) { reply = "Por favor, informe sua data de nascimento (DD/MM/AAAA)."; break; }
      session.profile.dob = input;
      reply = "Em qual *cidade* voce mora?";
      session.step = "consulta_cidade";
      break;

    case "consulta_cidade":
      if (!input) { reply = "Por favor, informe sua cidade."; break; }
      session.profile.city = input;
      reply = "Qual e o seu *e-mail*?";
      session.step = "consulta_email";
      break;

    case "consulta_email":
      if (!input || !input.includes("@")) { reply = "Por favor, informe um e-mail valido."; break; }
      session.profile.email = input;
      reply = "Quais *medicamentos* voce usa atualmente?\n(Liste separados por virgula ou escreva nenhum.)";
      session.step = "consulta_medicamentos";
      break;

    case "consulta_medicamentos": {
      if (!input) { reply = "Por favor, informe seus medicamentos ou escreva nenhum."; break; }
      session.profile.medications = input;
      var slots = generateSlots(6);
      session.appointmentSlots = slots;
      var slotLines = slots.map(function(s) { return "  *" + s.index + ".* " + s.label; }).join("\n");
      reply = "Cadastro completo!\n\nEscolha um horario disponivel:\n\n" + slotLines + "\n\nResponda com o *numero* do horario desejado (1 a " + slots.length + ").";
      session.step = "consulta_horario";
      break;
    }

    case "consulta_horario": {
      var choiceC = parseInt(input, 10);
      var slotListC = session.appointmentSlots || [];
      if (isNaN(choiceC) || choiceC < 1 || choiceC > slotListC.length) {
        reply = "Por favor, responda com um numero entre 1 e " + slotListC.length + ".\n\n" +
          slotListC.map(function(s) { return "  *" + s.index + ".* " + s.label; }).join("\n");
        break;
      }
      var booked = slotListC[choiceC - 1];
      session.bookedAppointment = booked;

      var patientCount = await patientsCol.countDocuments();
      var newId = "p" + String(patientCount + 1).padStart(3, "0");
      await patientsCol.insertOne({
        id: newId,
        name: session.profile.name,
        dob: session.profile.dob,
        city: session.profile.city,
        email: session.profile.email,
        medications: session.profile.medications,
        appointment: booked.isoDate,
        appointmentTime: booked.time,
        appointmentLabel: booked.label,
        registeredAt: new Date().toISOString(),
        source: "whatsapp",
        phone: senderId,
      });

      reply = "Consulta confirmada!\n\n" + booked.label + "\n\nUm lembrete sera enviado para *" + session.profile.email + "*.\n\n" +
        "Resumo do cadastro:\n" +
        "Nome: " + session.profile.name + "\n" +
        "Nascimento: " + session.profile.dob + "\n" +
        "Cidade: " + session.profile.city + "\n" +
        "E-mail: " + session.profile.email + "\n" +
        "Medicamentos: " + session.profile.medications + "\n\n" +
        "Posso ajudar com mais alguma coisa? Digite *menu* para voltar ao inicio.";
      session.step = "completo";
      break;
    }

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
        reply = msgProcedimentoContratacao(session.vendaPerfil);
        session.step = "venda_aguardando_cadastro";
      } else if (low.includes("nao") || low.includes("voltar")) {
        reply = msgApresentacaoPraxi();
        session.step = "venda_apresentacao";
      } else {
        reply = "Deseja seguir para me contratar? Responda *sim* para continuar ou *nao* para voltar.";
      }
      break;

    case "venda_aguardando_cadastro":
      if (low.includes("cadastr") || low.includes("preenchi") || low.includes("fiz o cadastro") || low.includes("conclu")) {
        reply = msgPix(session.vendaPerfil);
        session.step = "venda_aguardando_pagamento";
      } else if (isAfirmativo(input) || low.includes("paguei") || low.includes("pago")) {
        reply = "Pagamento recebido! Sua contratacao esta sendo processada. Em instantes voce recebera um e-mail de boas-vindas com seus dados de acesso. Obrigado por escolher o Praxi!\n\nDigite *menu* para voltar ao inicio.";
        session.step = "completo";
      } else {
        reply = "Para seguir com a contratacao:\n\n*1.* Acesse o link de cadastro e preencha seus dados:\n" + CADASTRO_URL + "\n\n*2.* Apos o cadastro, volte aqui e me avise que finalizou.";
      }
      break;

    case "venda_aguardando_pagamento":
      if (isAfirmativo(input) || low.includes("paguei") || low.includes("pago") || low.includes("fiz") || low.includes("realizei")) {
        reply = "Pagamento confirmado! Sua contratacao esta finalizada. Em instantes voce recebera o e-mail de boas-vindas com seus dados de acesso e instrucoes para ativar seu assistente Praxi. Obrigado!\n\nDigite *menu* para voltar ao inicio.";
        session.step = "completo";
      } else {
        reply = msgPix(session.vendaPerfil) + "\n\nApos realizar o pagamento, me avise aqui!";
      }
      break;

    case "completo":
      reply = "Posso ajudar com mais alguma coisa? Digite *menu* para voltar ao inicio.";
      break;

    default:
      reply = msgInicio();
      session.step = "aguardando_opcao_inicial";
  }

  session.updatedAt = new Date().toISOString();
  await saveSession(session);
  return { reply, session };
}

// ─── Anthropic helper ─────────────────────────────────────────────────────────

var SYSTEM_PROMPT = "Voce e o Praxi Bot, um assistente de apoio a decisao clinica. Forneca insights concisos e baseados em evidencias. Sempre lembre que suas respostas nao substituem o julgamento medico profissional.";

async function generateInsight(prompt, patientId, context) {
  var userMessage = context ? "Contexto do paciente:\n" + context + "\n\n" + prompt : prompt;
  var message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  var responseText = message.content[0].type === "text" ? message.content[0].text : "";
  var record = {
    id: "ins_" + Date.now(), patientId: patientId || null,
    prompt: prompt, context: context || null, response: responseText,
    model: message.model, createdAt: new Date().toISOString(),
  };
  await insightsCol.insertOne(record);
  return record;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function verifyJWT(req, res, next) {
  var auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de autorizacao ausente ou invalido" });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token invalido ou expirado" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Acesso restrito ao administrador" });
  }
  next();
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

app.get("/api/healthz", function(_req, res) { res.json({ status: "ok" }); });

app.get("/webhook", function(req, res) {
  var mode = req.query["hub.mode"];
  var token = req.query["hub.verify_token"];
  var challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: "Token de verificacao invalido" });
  }
});

app.post("/webhook", async function(req, res) {
  res.status(200).send("OK");
  var body = req.body;
  if (!body.object) return;
  var entry = body.entry && body.entry[0];
  var change = entry && entry.changes && entry.changes[0];
  var value = change && change.value;
  var message = value && value.messages && value.messages[0];
  if (!message) return;
  var from = message.from;
  var text = (message.text && message.text.body) || "";
  if (!text) return;

  var result = await processMessage(from, text);
  var reply = result.reply;

  try {
    await fetch("https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/messages", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.WHATSAPP_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply },
      }),
    });
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err.message);
  }
});

app.get("/api/webhook/sessions", async function(_req, res) {
  var all = await sessionsCol.find({}).toArray();
  res.json({ sessions: all, total: all.length });
});

app.get("/api/patients", async function(_req, res) {
  var all = await patientsCol.find({}).toArray();
  res.json({ patients: all, total: all.length });
});

app.get("/api/patients/:id", async function(req, res) {
  var patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Paciente nao encontrado" });
  res.json(patient);
});

app.post("/api/patients", async function(req, res) {
  var body = req.body;
  var missing = ["name", "dob", "city", "email", "medications"].filter(function(f) { return !body[f]; });
  if (missing.length) return res.status(400).json({ error: "Campos obrigatorios ausentes", missing: missing });
  var count = await patientsCol.countDocuments();
  var id = "p" + String(count + 1).padStart(3, "0");
  var patient = { id: id, name: body.name, dob: body.dob, city: body.city, email: body.email, medications: body.medications, diagnosis: body.diagnosis, appointment: body.appointment, registeredAt: new Date().toISOString(), source: "manual" };
  await patientsCol.insertOne(patient);
  res.status(201).json(patient);
});

app.post("/api/patients/:id/insight", async function(req, res) {
  var patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Paciente nao encontrado" });
  var prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: "prompt e obrigatorio" });
  var context = ["Nome: " + patient.name, "Nascimento: " + patient.dob, "Cidade: " + patient.city, "E-mail: " + patient.email, "Medicamentos: " + patient.medications, patient.diagnosis ? "Diagnostico: " + patient.diagnosis : null, patient.appointment ? "Proxima consulta: " + patient.appointment : null].filter(Boolean).join("\n");
  try {
    var record = await generateInsight(prompt, patient.id, context);
    res.json({ patient: patient, insight: record });
  } catch (err) {
    res.status(502).json({ error: "Erro na API Anthropic", detail: err.message });
  }
});

app.get("/api/patients/:id/insight/history", async function(req, res) {
  var records = await insightsCol.find({ patientId: req.params.id }).toArray();
  res.json({ patientId: req.params.id, insights: records, total: records.length });
});

app.post("/api/insight", async function(req, res) {
  var prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ error: "prompt e obrigatorio" });
  try {
    var record = await generateInsight(prompt, req.body.patientId || null, req.body.context || null);
    res.json(record);
  } catch (err) {
    res.status(502).json({ error: "Erro na API Anthropic", detail: err.message });
  }
});

app.get("/api/insight/history", async function(_req, res) {
  var all = await insightsCol.find({}).toArray();
  res.json({ insights: all, total: all.length });
});

app.post("/api/auth/register", async function(req, res) {
  var body = req.body;
  if (!body.name || !body.email || !body.password) return res.status(400).json({ error: "name, email e password sao obrigatorios" });
  var existing = await clientsCol.findOne({ email: body.email });
  if (existing) return res.status(409).json({ error: "E-mail ja cadastrado" });
  var passwordHash = await bcrypt.hash(body.password, 10);
  var id = "cl_" + Date.now();
  var nextBilling = new Date();
  nextBilling.setDate(nextBilling.getDate() + 30);
  var client = { id: id, name: body.name, email: body.email, passwordHash: passwordHash, type: body.type || "solo", crm: body.crm || null, specialty: body.specialty || null, phone: body.phone || null, createdAt: new Date().toISOString(), status: "active", plan: body.plan || "free", nextBilling: nextBilling.toISOString() };
  await clientsCol.insertOne(client);
  var safe = Object.assign({}, client);
  delete safe.passwordHash;
  res.status(201).json(safe);
});

app.post("/api/auth/login", async function(req, res) {
  var email = req.body.email;
  var password = req.body.password;
  if (!email || !password) return res.status(400).json({ error: "email e password sao obrigatorios" });
  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    var token = jwt.sign({ role: "admin", email: email }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token: token, role: "admin", expiresIn: "8h" });
  }
  var client = await clientsCol.findOne({ email: email });
  if (!client) return res.status(401).json({ error: "Credenciais invalidas" });
  var valid = await bcrypt.compare(password, client.passwordHash);
  if (!valid) return res.status(401).json({ error: "Credenciais invalidas" });
  if (client.status === "suspended") return res.status(403).json({ error: "Conta suspensa." });
  var clientToken = jwt.sign({ role: "client", id: client.id, email: email }, JWT_SECRET, { expiresIn: "8h" });
  var safe = Object.assign({}, client);
  delete safe.passwordHash;
  res.json({ token: clientToken, role: "client", expiresIn: "8h", client: safe });
});

app.get("/api/clients/me", verifyJWT, async function(req, res) {
  if (req.user.role !== "client") return res.status(403).json({ error: "Rota apenas para clientes" });
  var client = await clientsCol.findOne({ id: req.user.id });
  if (!client) return res.status(404).json({ error: "Cliente nao encontrado" });
  var safe = Object.assign({}, client);
  delete safe.passwordHash;
  res.json(safe);
});

app.patch("/api/clients/me", verifyJWT, async function(req, res) {
  if (req.user.role !== "client") return res.status(403).json({ error: "Rota apenas para clientes" });
  var allowed = ["name", "phone", "specialty", "crm"];
  var updates = {};
  allowed.forEach(function(f) { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (!Object.keys(updates).length) return res.status(400).json({ error: "Nenhum campo valido para atualizar" });
  await clientsCol.updateOne({ id: req.user.id }, { $set: updates });
  var client = await clientsCol.findOne({ id: req.user.id });
  var safe = Object.assign({}, client);
  delete safe.passwordHash;
  res.json({ updated: Object.keys(updates), client: safe });
});

app.get("/api/admin/clients", verifyJWT, adminOnly, async function(_req, res) {
  var all = await clientsCol.find({}).toArray();
  res.json({ clients: all.map(function(c) { var s = Object.assign({}, c); delete s.passwordHash; return s; }), total: all.length });
});

app.patch("/api/admin/clients/:id", verifyJWT, adminOnly, async function(req, res) {
  var updates = {};
  if (req.body.email !== undefined) updates.email = req.body.email;
  if (req.body.plan !== undefined) updates.plan = req.body.plan;
  if (req.body.status !== undefined) updates.status = req.body.status;
  await clientsCol.updateOne({ id: req.params.id }, { $set: updates });
  var client = await clientsCol.findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Cliente nao encontrado" });
  var safe = Object.assign({}, client);
  delete safe.passwordHash;
  res.json(safe);
});

app.delete("/api/admin/clients/:id", verifyJWT, adminOnly, async function(req, res) {
  var client = await clientsCol.findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Cliente nao encontrado" });
  await clientsCol.updateOne({ id: req.params.id }, { $set: { status: "suspended" } });
  res.json({ message: "Cliente suspenso com sucesso" });
});

app.get("/api/register-phone", async function(_req, res) {
  try {
    var response = await fetch("https://graph.facebook.com/v20.0/" + process.env.WHATSAPP_PHONE_ID + "/register", {
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
