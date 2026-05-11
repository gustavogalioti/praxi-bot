require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory stores ────────────────────────────────────────────────────────

const messages = [];
const insightHistory = [];
const sessions = {};

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
      reply = "👋 Hello! I'm Praxi Bot, your clinical assistant.\nTo get started, could I have your full name?";
      session.step = "awaiting_name";
      break;
    case "awaiting_name":
      if (!input) { reply = "Please enter your full name to continue."; break; }
      session.profile.name = input;
      reply = `Thanks, ${input}! 📋\nWhat is your date of birth? (e.g. MM/DD/YYYY)`;
      session.step = "awaiting_dob";
      break;
    case "awaiting_dob":
      if (!input) { reply = "Please enter your date of birth (MM/DD/YYYY)."; break; }
      session.profile.dob = input;
      reply = "Got it. 🏙️ What city do you live in?";
      session.step = "awaiting_city";
      break;
    case "awaiting_city":
      if (!input) { reply = "Please enter your city."; break; }
      session.profile.city = input;
      reply = "Great! What is your email address?";
      session.step = "awaiting_email";
      break;
    case "awaiting_email":
      if (!input || !input.includes("@")) { reply = "Please enter a valid email address."; break; }
      session.profile.email = input;
      reply = "Thanks! 💊 Please list any current medications you're taking.\n(You can type them separated by commas, or type \"none\".)";
      session.step = "awaiting_medications";
      break;
    case "awaiting_medications":
      if (!input) { reply = 'Please enter your current medications, or type "none".'; break; }
      session.profile.medications = input;
      const slots = generateSlots(6);
      session.appointmentSlots = slots;
      reply = "✅ Your profile is all set!\n\nHere are available appointment slots on Monday, Wednesday, and Friday:\n\n" +
        slots.map(s => `  ${s.index}. ${s.label}`).join("\n") +
        `\n\nReply with the number of your preferred slot (1–${slots.length}).`;
      session.step = "awaiting_appointment";
      break;
    case "awaiting_appointment":
      const choice = parseInt(input, 10);
      const slotList = session.appointmentSlots || [];
      if (isNaN(choice) || choice < 1 || choice > slotList.length) {
        reply = `Please reply with a number between 1 and ${slotList.length}.\n\n` +
          slotList.map(s => `  ${s.index}. ${s.label}`).join("\n");
        break;
      }
      const booked = slotList[choice - 1];
      session.bookedAppointment = booked;
      reply = `🗓️ Confirmed! Your appointment is booked for:\n*${booked.label}*\n\n` +
        `A reminder will be sent to ${session.profile.email}.\n\n` +
        `Here's a summary of your profile:\n` +
        `• Name: ${session.profile.name}\n• DOB: ${session.profile.dob}\n` +
        `• City: ${session.profile.city}\n• Email: ${session.profile.email}\n` +
        `• Medications: ${session.profile.medications}\n\nIs there anything else I can help you with?`;
      session.step = "complete";
      break;
    case "complete":
      if (input.toLowerCase() === "restart") {
        delete sessions[senderId];
        const fresh = getSession(senderId);
        fresh.step = "awaiting_name";
        fresh.updatedAt = new Date().toISOString();
        reply = "Starting over! 👋\nTo get started, could I have your full name?";
        return { reply, session: fresh };
      }
      reply = "You're all set! Send \"restart\" to begin again.";
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

// ─── Routes ───────────────────────────────────────────────────────────────────

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
app.post("/webhook", (req, res) => {
  const body = req.body;
  const senderId = body.sender || "unknown";
  const text = body.message || "";
  const { reply, session } = processMessage(senderId, text);
  const record = {
    id: `msg_${Date.now()}`, senderId,
    receivedAt: new Date().toISOString(), inbound: body, reply, step: session.step,
  };
  messages.push(record);
  res.status(200).json({ status: "received", reply, step: session.step });
});

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

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Praxi Bot running on port ${PORT}`));
