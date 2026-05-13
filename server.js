require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");


const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || "praxi_jwt_secret_change_in_production";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory stores ────────────────────────────────────────────────────────

const messages = [];
const insightHistory = [];
const sessions = {};
const clients = {};

const patients = {
  p001: {
    id: "p001", name: "Alice Johnson", dob: "1992-03-05", city: "New York",
    email: "alice@example.com", medications: "Metformin 500mg, Lisinopril 10mg",
    diagnosis: "Type 2 Diabetes", appointment: "2026-06-10",
    registeredAt: "2026-04-15T00:00:00.000Z", source: "manual",
  },
  p002: {
    id: "p002", name: "Bob Martinez", dob: "1968-07-22", city: "Los Angeles",
    email: "bob@example.com", medications: "Amlodipine 5mg, Atorvastatin 20mg",
    diagnosis: "Hypertension", appointment: "2026-05-20",
    registeredAt: "2026-03-22T00:00:00.000Z", source: "manual",
  },
  p003: {
    id: "p003", name: "Carol Lee", dob: "1981-11-30", city: "Chicago",
    email: "carol@example.com", medications: "Albuterol inhaler, Fluticasone inhaler",
    diagnosis: "Asthma", appointment: "2026-07-01",
    registeredAt: "2026-05-01T00:00:00.000Z", source: "manual",
  },
};

// ─── Conversation engine ──────────────────────────────────────────────────────

function generateSlots(count = 6) {
  const slots = [];
  const allowedDays = [1, 3, 5];
  const times = ["9:00 AM", "11:00 AM", "2:00 PM", "4:00 PM"];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + 1);
  while (slots.length < count) {
    if (allowedDays.includes(cursor.getDay())) {
      slots.push({
        index: slots.length + 1,
        label: cursor.toLocaleDateString("en-US", {
          weekday: "long", month: "long", day: "numeric", year: "numeric",
        }) + ` at ${times[slots.length % times.length]}`,
        isoDate: cursor.toISOString().split("T")[0],
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

function getSession(senderId) {
  if (!sessions[senderId]) {
    sessions[senderId] = {
      senderId, step: "new", profile: {},
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  }
  return sessions[senderId];
}

function processMessage(senderId, text) {
  const session = getSession(senderId);
  const input = text.trim();
  let reply = "";

  switch (session.step) {
    case "new":
      reply = "👋 Olá! Sou o Praxi, seu assistente clínico.\nPara começar, qual é o seu nome completo?";
      session.step = "awaiting_name";
      break;
    case "awaiting_name":
      if (!input) { reply = "Por favor, informe seu nome completo para continuar."; break; }
      session.profile.name = input;
      reply = `Obrigado, ${input}! 📋\nQual é a sua data de nascimento? (ex: DD/MM/AAAA)`;
      session.step = "awaiting_dob";
      break;
    case "awaiting_dob":
      if (!input) { reply = "Por favor, informe sua data de nascimento (DD/MM/AAAA)."; break; }
      session.profile.dob = input;
      reply = "Entendido. 🏙️ Em qual cidade você mora?";
      session.step = "awaiting_city";
      break;
    case "awaiting_city":
      if (!input) { reply = "Por favor, informe sua cidade."; break; }
      session.profile.city = input;
      reply = "Ótimo! Qual é o seu endereço de e-mail?";
      session.step = "awaiting_email";
      break;
    case "awaiting_email":
      if (!input || !input.includes("@")) { reply = "Por favor, informe um endereço de e-mail válido."; break; }
      session.profile.email = input;
      reply = "Obrigado! 💊 Por favor, liste os medicamentos que você usa atualmente.\n(Você pode digitá-los separados por vírgula, ou escrever \"nenhum\".)";
      session.step = "awaiting_medications";
      break;
    case "awaiting_medications":
      if (!input) { reply = "Por favor, informe seus medicamentos atuais, ou escreva \"nenhum\"."; break; }
      session.profile.medications = input;
      const slots = generateSlots(6);
      session.appointmentSlots = slots;
      reply = "✅ Seu cadastro está completo!\n\nAqui estão os horários disponíveis para consulta (segunda, quarta e sexta):\n\n" +
        slots.map(s => `  ${s.index}. ${s.label}`).join("\n") +
        `\n\nResponda com o número do horário de sua preferência (1–${slots.length}).`;
      session.step = "awaiting_appointment";
      break;
    case "awaiting_appointment":
      const choice = parseInt(input, 10);
      const slotList = session.appointmentSlots || [];
      if (isNaN(choice) || choice < 1 || choice > slotList.length) {
        reply = `Por favor, responda com um número entre 1 e ${slotList.length}.\n\n` +
          slotList.map(s => `  ${s.index}. ${s.label}`).join("\n");
        break;
      }
      const booked = slotList[choice - 1];
      session.bookedAppointment = booked;
      reply = `🗓️ Confirmado! Sua consulta está agendada para:\n*${booked.label}*\n\n` +
        `Um lembrete será enviado para ${session.profile.email}.\n\n` +
        `Aqui está um resumo do seu cadastro:\n` +
        `• Nome: ${session.profile.name}\n• Nascimento: ${session.profile.dob}\n` +
        `• Cidade: ${session.profile.city}\n• E-mail: ${session.profile.email}\n` +
        `• Medicamentos: ${session.profile.medications}\n\nPosso ajudar com mais alguma coisa?`;
      session.step = "complete";
      break;
    case "complete":
      if (input.toLowerCase() === "reiniciar") {
        delete sessions[senderId];
        const fresh = getSession(senderId);
        fresh.step = "awaiting_name";
        fresh.updatedAt = new Date().toISOString();
        reply = "Recomeçando! 👋\nQual é o seu nome completo?";
        return { reply, session: fresh };
      }
      reply = "Tudo certo! Envie \"reiniciar\" para começar novamente.";
      break;
  }

  session.updatedAt = new Date().toISOString();
  return { reply, session };
}

// ─── Shared Anthropic helper ──────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are Praxi Bot, a clinical decision-support assistant. " +
  "Provide concise, evidence-based medical insights. " +
  "Always remind users that your output is not a substitute for professional medical judgment.";

async function generateInsight(prompt, patientId, context) {
  const userMessage = context ? `Patient context:\n${context}\n\n${prompt}` : prompt;
  const message = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
  const responseText = message.content[0].type === "text" ? message.content[0].text : "";
  const record = {
    id: `ins_${Date.now()}`, patientId: patientId || null,
    prompt, context: context || null, response: responseText,
    model: message.model, createdAt: new Date().toISOString(),
  };
  insightHistory.push(record);
  return record;
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function verifyJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Privacy policy
app.get("/privacy", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Política de Privacidade — Praxi Bot</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; line-height: 1.7; }
    header { background: #0d6efd; color: #fff; padding: 48px 24px 36px; text-align: center; }
    header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
    header p  { font-size: 1rem; opacity: 0.85; }
    main { max-width: 780px; margin: 40px auto; padding: 0 24px 60px; }
    section { margin-bottom: 40px; }
    h2 { font-size: 1.2rem; font-weight: 700; color: #0d6efd; border-left: 4px solid #0d6efd; padding-left: 12px; margin-bottom: 14px; }
    p { margin-bottom: 12px; font-size: 0.97rem; }
    ul { padding-left: 20px; margin-bottom: 12px; }
    ul li { margin-bottom: 6px; font-size: 0.97rem; }
    .badge { display: inline-block; background: #e8f0fe; color: #0d6efd; font-size: 0.82rem; font-weight: 600; padding: 2px 10px; border-radius: 20px; margin-bottom: 16px; }
    .card { background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 2px 12px rgba(0,0,0,.07); }
    .contact-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
    .contact-item { background: #f0f4ff; border-radius: 8px; padding: 14px 18px; }
    .contact-item strong { display: block; font-size: 0.82rem; color: #555; margin-bottom: 2px; }
    .contact-item span { font-size: 0.95rem; color: #0d6efd; }
    footer { text-align: center; padding: 24px; font-size: 0.82rem; color: #888; border-top: 1px solid #e0e0e0; }
    @media (max-width: 520px) { header h1 { font-size: 1.5rem; } .contact-grid { grid-template-columns: 1fr; } .card { padding: 20px; } }
  </style>
</head>
<body>
<header>
  <h1>Política de Privacidade</h1>
  <p>Praxi Bot — Assistente WhatsApp para médicos e clínicas no Brasil</p>
</header>
<main>
  <section><div class="card">
    <span class="badge">Última atualização: maio de 2026</span>
    <p>A <strong>Praxi Bot</strong> é uma solução de suporte à decisão clínica via WhatsApp, desenvolvida para auxiliar médicos e clínicas no Brasil. Esta Política de Privacidade descreve quais dados coletamos, como os utilizamos e como protegemos suas informações, em conformidade com a <strong>Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018)</strong>.</p>
    <p>Ao utilizar a Praxi Bot, você concorda com os termos descritos nesta política.</p>
  </div></section>
  <section><h2>1. Dados que Coletamos</h2><div class="card">
    <p>Durante a conversa com a Praxi Bot, coletamos as seguintes informações fornecidas voluntariamente:</p>
    <ul>
      <li><strong>Nome completo</strong> — para identificação do paciente ou profissional.</li>
      <li><strong>Data de nascimento</strong> — para contextualização clínica.</li>
      <li><strong>Cidade</strong> — para fins de localização e agendamento.</li>
      <li><strong>Endereço de e-mail</strong> — para envio de lembretes e confirmações.</li>
      <li><strong>Medicamentos em uso</strong> — para suporte à decisão clínica e verificação de interações medicamentosas.</li>
      <li><strong>Consultas agendadas</strong> — data e horário das consultas escolhidas pelo usuário.</li>
    </ul>
    <p>Também registramos automaticamente as mensagens trocadas com o bot (conteúdo e horário) para fins de funcionamento do serviço e rastreabilidade.</p>
  </div></section>
  <section><h2>2. Como Usamos os Dados</h2><div class="card">
    <p>Os dados coletados são utilizados exclusivamente para:</p>
    <ul>
      <li>Conduzir o fluxo de atendimento e coletar o cadastro do paciente;</li>
      <li>Gerar <strong>insights clínicos personalizados</strong> com base no perfil do paciente, usando inteligência artificial (Anthropic Claude);</li>
      <li>Oferecer e confirmar <strong>agendamentos</strong> em dias e horários disponíveis;</li>
      <li>Enviar lembretes de consultas ao e-mail informado;</li>
      <li>Melhorar a qualidade e a precisão do serviço.</li>
    </ul>
    <p><strong>Não vendemos, alugamos ou compartilhamos seus dados com terceiros</strong> para fins comerciais ou de marketing.</p>
  </div></section>
  <section><h2>3. Uso de Inteligência Artificial</h2><div class="card">
    <p>A Praxi Bot utiliza o modelo de linguagem <strong>Claude (Anthropic)</strong> para gerar sugestões clínicas com base nos dados do paciente. As informações enviadas à API da Anthropic são tratadas conforme a <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener">Política de Privacidade da Anthropic</a>.</p>
    <p><strong>Os insights gerados são apenas de suporte à decisão clínica</strong> e não substituem o julgamento profissional médico. Sempre consulte um profissional habilitado.</p>
  </div></section>
  <section><h2>4. Armazenamento e Segurança</h2><div class="card">
    <p>Os dados são armazenados <strong>em memória durante a sessão ativa</strong>. Não utilizamos banco de dados persistente para as informações de conversa nesta versão do serviço. Isso significa que os dados são apagados automaticamente quando o servidor é reiniciado.</p>
    <p>Adotamos medidas técnicas para proteger as informações transmitidas, incluindo comunicação via HTTPS e autenticação por token para o webhook.</p>
  </div></section>
  <section><h2>5. Seus Direitos (LGPD)</h2><div class="card">
    <p>Nos termos da LGPD, você tem direito a:</p>
    <ul>
      <li>Confirmar a existência de tratamento dos seus dados;</li>
      <li>Acessar os dados que temos sobre você;</li>
      <li>Corrigir dados incompletos, inexatos ou desatualizados;</li>
      <li>Solicitar a eliminação dos seus dados;</li>
      <li>Revogar o consentimento a qualquer momento.</li>
    </ul>
    <p>Para exercer qualquer um desses direitos, entre em contato pelo e-mail abaixo.</p>
  </div></section>
  <section><h2>6. Contato</h2><div class="card">
    <p>Em caso de dúvidas, solicitações ou exercício de direitos previstos na LGPD, entre em contato:</p>
    <div class="contact-grid">
      <div class="contact-item"><strong>Responsável</strong><span>Praxi Bot</span></div>
      <div class="contact-item"><strong>E-mail</strong><span>privacidade@praxibot.com.br</span></div>
      <div class="contact-item"><strong>WhatsApp</strong><span>+55 (11) 99999-9999</span></div>
      <div class="contact-item"><strong>País de operação</strong><span>Brasil</span></div>
    </div>
  </div></section>
  <section><div class="card">
    <p>Esta política pode ser atualizada periodicamente. Recomendamos que você a revise regularmente. O uso continuado do serviço após alterações implica aceitação dos novos termos.</p>
  </div></section>
</main>
<footer>&copy; 2026 Praxi Bot. Todos os direitos reservados. Operado em conformidade com a LGPD.</footer>
</body>
</html>`);
});

// Health
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

// Webhook verification
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: "Forbidden: verification token mismatch" });
  }
});

// Webhook message intake + conversation flow
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK");
console.log("WEBHOOK RECEBIDO:", JSON.stringify(req.body));
  const body = req.body;
  if (!body.object) return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  if (!message) return;

  const from = message.from;
  const text = message.text?.body || "";

  if (!text) return;

  const { reply } = processMessage(from, text);

  try {
    await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
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
})
// Webhook messages & sessions
app.get("/api/webhook/messages", (req, res) => {
  const { sender, from, to } = req.query;
  let result = [...messages];
  if (sender) result = result.filter(m => m.senderId === sender);
  if (from) result = result.filter(m => new Date(m.receivedAt) >= new Date(from));
  if (to) result = result.filter(m => new Date(m.receivedAt) <= new Date(to));
  res.json({ messages: result, total: result.length });
});

app.get("/api/webhook/sessions", (_req, res) => {
  const all = Object.values(sessions);
  res.json({ sessions: all, total: all.length });
});

// Patients
app.get("/api/patients", (_req, res) => {
  const all = Object.values(patients);
  res.json({ patients: all, total: all.length });
});

app.get("/api/patients/:id", (req, res) => {
  const patient = patients[req.params.id];
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  res.json(patient);
});

app.post("/api/patients", (req, res) => {
  const body = req.body;
  let name, dob, city, email, medications, diagnosis, appointment, source = "manual";

  if (body.fromSession) {
    const session = sessions[body.fromSession];
    if (!session) return res.status(404).json({ error: `No session found for sender "${body.fromSession}"` });
    if (session.step !== "complete") return res.status(422).json({
      error: "Session is not complete yet", step: session.step,
      detail: "The conversation must finish all steps before registering a patient.",
    });
    ({ name, dob, city, email, medications } = session.profile);
    appointment = session.bookedAppointment?.isoDate;
    source = "session";
  } else {
    ({ name, dob, city, email, medications, diagnosis, appointment } = body);
  }

  const missing = ["name", "dob", "city", "email", "medications"].filter(f => !eval(f));
  if (missing.length) return res.status(400).json({ error: "Missing required fields", missing });

  const id = `p${String(Object.keys(patients).length + 1).padStart(3, "0")}`;
  const patient = { id, name, dob, city, email, medications, diagnosis, appointment, registeredAt: new Date().toISOString(), source };
  patients[id] = patient;
  res.status(201).json(patient);
});

app.get("/api/patients/:id/insight/history", (req, res) => {
  const patient = patients[req.params.id];
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  const records = insightHistory.filter(r => r.patientId === patient.id);
  res.json({ patientId: patient.id, insights: records, total: records.length });
});

app.post("/api/patients/:id/insight", async (req, res) => {
  const patient = patients[req.params.id];
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  const context = [
    `Name: ${patient.name}`, `Date of birth: ${patient.dob}`,
    `City: ${patient.city}`, `Email: ${patient.email}`,
    `Current medications: ${patient.medications}`,
    patient.diagnosis ? `Diagnosis: ${patient.diagnosis}` : null,
    patient.appointment ? `Next appointment: ${patient.appointment}` : null,
  ].filter(Boolean).join("\n");

  try {
    const record = await generateInsight(prompt, patient.id, context);
    res.json({ patient, insight: record });
  } catch (err) {
    res.status(502).json({ error: "Anthropic API error", detail: err.message });
  }
});

// Insights
app.post("/api/insight", async (req, res) => {
  const { prompt, patientId, context } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });
  try {
    const record = await generateInsight(prompt, patientId || null, context || null);
    res.json(record);
  } catch (err) {
    res.status(502).json({ error: "Anthropic API error", detail: err.message });
  }
});

app.get("/api/insight/history", (_req, res) => {
  res.json({ insights: insightHistory, total: insightHistory.length });
});

// Simulate
app.post("/api/simulate", (req, res) => {
  const { phone, messages: msgs } = req.body;
  if (!phone || typeof phone !== "string") return res.status(400).json({ error: "phone is required" });
  if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: "messages must be a non-empty array" });

  delete sessions[phone];
  const log = [];
  for (let i = 0; i < msgs.length; i++) {
    const { reply, session } = processMessage(phone, msgs[i]);
    log.push({ turn: i + 1, sender: phone, message: msgs[i], botReply: reply, step: session.step });
    if (session.step === "complete") break;
  }
  res.json({ phone, turns: log.length, finalStep: log[log.length - 1]?.step, conversation: log });
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

// POST /api/auth/register — create a new client account
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, type, crm, specialty, phone, plan } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  const existing = Object.values(clients).find(c => c.email === email);
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const id = `cl_${Date.now()}`;
  const nextBillingDate = new Date();
  nextBillingDate.setDate(nextBillingDate.getDate() + 30);

  const client = {
    id,
    name,
    email,
    passwordHash,
    type: type || "solo",
    crm: crm || null,
    specialty: specialty || null,
    phone: phone || null,
    createdAt: new Date().toISOString(),
    status: "active",
    plan: plan || "free",
    nextBilling: nextBillingDate.toISOString(),
  };
  clients[id] = client;

  const { passwordHash: _, ...safe } = client;
  res.status(201).json(safe);
});

// POST /api/auth/login — returns JWT for clients and admin
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  // Admin check
  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: "admin", email }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token, role: "admin", expiresIn: "8h" });
  }

  // Client check
  const client = Object.values(clients).find(c => c.email === email);
  if (!client) return res.status(401).json({ error: "Invalid credentials" });

  const valid = await bcrypt.compare(password, client.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  if (client.status === "suspended") {
    return res.status(403).json({ error: "Account suspended. Contact support." });
  }

  const token = jwt.sign({ role: "client", id: client.id, email }, JWT_SECRET, { expiresIn: "8h" });
  const { passwordHash: _, ...safe } = client;
  res.json({ token, role: "client", expiresIn: "8h", client: safe });
});

// ─── Client self-service routes (JWT protected) ───────────────────────────────

// GET /api/clients/me — return the authenticated client's own profile
app.get("/api/clients/me", verifyJWT, (req, res) => {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "This route is for client accounts only" });
  }
  const client = clients[req.user.id];
  if (!client) return res.status(404).json({ error: "Client not found" });
  const { passwordHash: _, ...safe } = client;
  res.json(safe);
});

// PATCH /api/clients/me — update own profile fields
app.patch("/api/clients/me", verifyJWT, (req, res) => {
  if (req.user.role !== "client") {
    return res.status(403).json({ error: "This route is for client accounts only" });
  }
  const client = clients[req.user.id];
  if (!client) return res.status(404).json({ error: "Client not found" });

  const allowed = ["name", "phone", "specialty", "crm"];
  const updated = [];
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      client[field] = req.body[field];
      updated.push(field);
    }
  }
  if (!updated.length) {
    return res.status(400).json({ error: "No updatable fields provided", allowed });
  }

  const { passwordHash: _, ...safe } = client;
  res.json({ updated, client: safe });
});

// ─── Admin routes (JWT protected, admin only) ─────────────────────────────────

// GET /api/admin/clients — list all registered clients
app.get("/api/admin/clients", verifyJWT, adminOnly, (_req, res) => {
  const all = Object.values(clients).map(({ passwordHash: _, ...c }) => c);
  res.json({ clients: all, total: all.length });
});

// PATCH /api/admin/clients/:id — edit client email, plan, or status
app.patch("/api/admin/clients/:id", verifyJWT, adminOnly, (req, res) => {
  const client = clients[req.params.id];
  if (!client) return res.status(404).json({ error: "Client not found" });

  const { email, plan, status } = req.body;
  if (email !== undefined) client.email = email;
  if (plan !== undefined) client.plan = plan;
  if (status !== undefined) client.status = status;

  const { passwordHash: _, ...safe } = client;
  res.json(safe);
});

// DELETE /api/admin/clients/:id — suspend client account
app.delete("/api/admin/clients/:id", verifyJWT, adminOnly, (req, res) => {
  const client = clients[req.params.id];
  if (!client) return res.status(404).json({ error: "Client not found" });

  client.status = "suspended";
  const { passwordHash: _, ...safe } = client;
  res.json({ message: "Client suspended successfully", client: safe });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.get("/api/register-phone", async (req, res) => {
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/register`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        pin: "000000"
      }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Praxi Bot running on port ${PORT}`));
