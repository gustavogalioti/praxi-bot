require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || "praxi_jwt_secret_change_in_production";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MONGODB_URI = process.env.MONGODB_URI;
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MongoDB ──────────────────────────────────────────────────────────────────

let db;
let patientsCol, clientsCol, sessionsCol, insightsCol;

async function connectDB() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db("praxi");
  patientsCol  = db.collection("patients");
  clientsCol   = db.collection("clients");
  sessionsCol  = db.collection("sessions");
  insightsCol  = db.collection("insights");
  console.log("MongoDB conectado ✅");

  // Seed inicial de pacientes se coleção estiver vazia
  const count = await patientsCol.countDocuments();
  if (count === 0) {
    await patientsCol.insertMany([
      { id: "p001", name: "Alice Johnson", dob: "1992-03-05", city: "New York", email: "alice@example.com", medications: "Metformin 500mg, Lisinopril 10mg", diagnosis: "Type 2 Diabetes", appointment: "2026-06-10", registeredAt: "2026-04-15T00:00:00.000Z", source: "manual" },
      { id: "p002", name: "Bob Martinez", dob: "1968-07-22", city: "Los Angeles", email: "bob@example.com", medications: "Amlodipine 5mg, Atorvastatin 20mg", diagnosis: "Hypertension", appointment: "2026-05-20", registeredAt: "2026-03-22T00:00:00.000Z", source: "manual" },
      { id: "p003", name: "Carol Lee", dob: "1981-11-30", city: "Chicago", email: "carol@example.com", medications: "Albuterol inhaler, Fluticasone inhaler", diagnosis: "Asthma", appointment: "2026-07-01", registeredAt: "2026-05-01T00:00:00.000Z", source: "manual" },
    ]);
    console.log("Pacientes iniciais inseridos ✅");
  }
}

// ─── Sessions (in-memory para velocidade, persistidas no Mongo) ───────────────

const sessions = {};

async function getSession(senderId) {
  if (!sessions[senderId]) {
    // Tenta recuperar do banco
    const saved = await sessionsCol.findOne({ senderId });
    if (saved) {
      sessions[senderId] = saved;
    } else {
      sessions[senderId] = {
        senderId, step: "new", profile: {},
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

// ─── Conversation engine ──────────────────────────────────────────────────────

function generateSlots(count = 6) {
  const slots = [];
  const allowedDays = [1, 2, 3, 4, 5]; // segunda a sexta
  const times = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00", "17:00"];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + 1);
  while (slots.length < count) {
    if (allowedDays.includes(cursor.getDay())) {
      times.forEach(t => {
        if (slots.length < count) {
          const [h, m] = t.split(":");
          const dt = new Date(cursor);
          dt.setHours(parseInt(h), parseInt(m), 0, 0);
          slots.push({
            index: slots.length + 1,
            label: dt.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + ` às ${t}`,
            isoDate: dt.toISOString().split("T")[0],
            time: t,
          });
        }
      });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return slots;
}

async function processMessage(senderId, text) {
  const session = await getSession(senderId);
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
      reply = "✅ Seu cadastro está completo!\n\nAqui estão os horários disponíveis para consulta:\n\n" +
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

      // Salva paciente no MongoDB
      const patientCount = await patientsCol.countDocuments();
      const newId = `p${String(patientCount + 1).padStart(3, "0")}`;
      const newPatient = {
        id: newId,
        ...session.profile,
        appointment: booked.isoDate,
        appointmentTime: booked.time,
        registeredAt: new Date().toISOString(),
        source: "whatsapp",
        phone: senderId,
      };
      await patientsCol.insertOne(newPatient);

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
        await sessionsCol.deleteOne({ senderId });
        const fresh = await getSession(senderId);
        fresh.step = "awaiting_name";
        fresh.updatedAt = new Date().toISOString();
        await saveSession(fresh);
        reply = "Recomeçando! 👋\nQual é o seu nome completo?";
        return { reply, session: fresh };
      }
      reply = "Tudo certo! Envie \"reiniciar\" para começar novamente.";
      break;
  }

  session.updatedAt = new Date().toISOString();
  await saveSession(session);
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
  await insightsCol.insertOne(record);
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
    footer { text-align: center; padding: 24px; font-size: 0.82rem; color: #888; border-top: 1px solid #e0e0e0; }
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
    <p>A <strong>Praxi Bot</strong> é uma solução de suporte à decisão clínica via WhatsApp, em conformidade com a <strong>LGPD (Lei nº 13.709/2018)</strong>.</p>
  </div></section>
</main>
<footer>&copy; 2026 Praxi Bot. Todos os direitos reservados.</footer>
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

  const { reply } = await processMessage(from, text);

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
});

// Webhook sessions
app.get("/api/webhook/sessions", async (_req, res) => {
  const all = await sessionsCol.find({}).toArray();
  res.json({ sessions: all, total: all.length });
});

// Patients
app.get("/api/patients", async (_req, res) => {
  const all = await patientsCol.find({}).toArray();
  res.json({ patients: all, total: all.length });
});

app.get("/api/patients/:id", async (req, res) => {
  const patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  res.json(patient);
});

app.post("/api/patients", async (req, res) => {
  const body = req.body;
  let name, dob, city, email, medications, diagnosis, appointment, source = "manual";

  if (body.fromSession) {
    const session = sessions[body.fromSession] || await sessionsCol.findOne({ senderId: body.fromSession });
    if (!session) return res.status(404).json({ error: `No session found for sender "${body.fromSession}"` });
    if (session.step !== "complete") return res.status(422).json({ error: "Session is not complete yet", step: session.step });
    ({ name, dob, city, email, medications } = session.profile);
    appointment = session.bookedAppointment?.isoDate;
    source = "session";
  } else {
    ({ name, dob, city, email, medications, diagnosis, appointment } = body);
  }

  const missing = ["name", "dob", "city", "email", "medications"].filter(f => !eval(f));
  if (missing.length) return res.status(400).json({ error: "Missing required fields", missing });

  const count = await patientsCol.countDocuments();
  const id = `p${String(count + 1).padStart(3, "0")}`;
  const patient = { id, name, dob, city, email, medications, diagnosis, appointment, registeredAt: new Date().toISOString(), source };
  await patientsCol.insertOne(patient);
  res.status(201).json(patient);
});

app.get("/api/patients/:id/insight/history", async (req, res) => {
  const patient = await patientsCol.findOne({ id: req.params.id });
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  const records = await insightsCol.find({ patientId: patient.id }).toArray();
  res.json({ patientId: patient.id, insights: records, total: records.length });
});

app.post("/api/patients/:id/insight", async (req, res) => {
  const patient = await patientsCol.findOne({ id: req.params.id });
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

app.get("/api/insight/history", async (_req, res) => {
  const all = await insightsCol.find({}).toArray();
  res.json({ insights: all, total: all.length });
});

// Simulate
app.post("/api/simulate", async (req, res) => {
  const { phone, messages: msgs } = req.body;
  if (!phone || typeof phone !== "string") return res.status(400).json({ error: "phone is required" });
  if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: "messages must be a non-empty array" });

  delete sessions[phone];
  await sessionsCol.deleteOne({ senderId: phone });
  const log = [];
  for (let i = 0; i < msgs.length; i++) {
    const { reply, session } = await processMessage(phone, msgs[i]);
    log.push({ turn: i + 1, sender: phone, message: msgs[i], botReply: reply, step: session.step });
    if (session.step === "complete") break;
  }
  res.json({ phone, turns: log.length, finalStep: log[log.length - 1]?.step, conversation: log });
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password, type, crm, specialty, phone, plan } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "name, email and password are required" });
  }
  const existing = await clientsCol.findOne({ email });
  if (existing) return res.status(409).json({ error: "Email already registered" });

  const passwordHash = await bcrypt.hash(password, 10);
  const id = `cl_${Date.now()}`;
  const nextBillingDate = new Date();
  nextBillingDate.setDate(nextBillingDate.getDate() + 30);

  const client = {
    id, name, email, passwordHash,
    type: type || "solo",
    crm: crm || null,
    specialty: specialty || null,
    phone: phone || null,
    createdAt: new Date().toISOString(),
    status: "active",
    plan: plan || "free",
    nextBilling: nextBillingDate.toISOString(),
  };
  await clientsCol.insertOne(client);
  const { passwordHash: _, ...safe } = client;
  res.status(201).json(safe);
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: "admin", email }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ token, role: "admin", expiresIn: "8h" });
  }

  const client = await clientsCol.findOne({ email });
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

// ─── Client self-service routes ───────────────────────────────────────────────

app.get("/api/clients/me", verifyJWT, async (req, res) => {
  if (req.user.role !== "client") return res.status(403).json({ error: "This route is for client accounts only" });
  const client = await clientsCol.findOne({ id: req.user.id });
  if (!client) return res.status(404).json({ error: "Client not found" });
  const { passwordHash: _, ...safe } = client;
  res.json(safe);
});

app.patch("/api/clients/me", verifyJWT, async (req, res) => {
  if (req.user.role !== "client") return res.status(403).json({ error: "This route is for client accounts only" });
  const allowed = ["name", "phone", "specialty", "crm"];
  const updates = {};
  for (const field of allowed) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: "No updatable fields provided", allowed });
  await clientsCol.updateOne({ id: req.user.id }, { $set: updates });
  const client = await clientsCol.findOne({ id: req.user.id });
  const { passwordHash: _, ...safe } = client;
  res.json({ updated: Object.keys(updates), client: safe });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────

app.get("/api/admin/clients", verifyJWT, adminOnly, async (_req, res) => {
  const all = await clientsCol.find({}).toArray();
  const safe = all.map(({ passwordHash: _, ...c }) => c);
  res.json({ clients: safe, total: safe.length });
});

app.patch("/api/admin/clients/:id", verifyJWT, adminOnly, async (req, res) => {
  const { email, plan, status } = req.body;
  const updates = {};
  if (email !== undefined) updates.email = email;
  if (plan !== undefined) updates.plan = plan;
  if (status !== undefined) updates.status = status;
  await clientsCol.updateOne({ id: req.params.id }, { $set: updates });
  const client = await clientsCol.findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Client not found" });
  const { passwordHash: _, ...safe } = client;
  res.json(safe);
});

app.delete("/api/admin/clients/:id", verifyJWT, adminOnly, async (req, res) => {
  const client = await clientsCol.findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Client not found" });
  await clientsCol.updateOne({ id: req.params.id }, { $set: { status: "suspended" } });
  const updated = await clientsCol.findOne({ id: req.params.id });
  const { passwordHash: _, ...safe } = updated;
  res.json({ message: "Client suspended successfully", client: safe });
});

// ─── Register phone (Meta) ────────────────────────────────────────────────────

app.get("/api/register-phone", async (req, res) => {
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/register`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: "000000" }),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Praxi Bot running on port ${PORT}`));
}).catch(err => {
  console.error("Falha ao conectar MongoDB:", err);
  process.exit(1);
});
