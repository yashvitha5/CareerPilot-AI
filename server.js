require("dotenv").config();

const express = require("express");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "careerpilot.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || "change-this-before-deployment",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 2
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !name.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      password.length < 8
    ) {
      return res.status(400).json({
        error: "Enter a name, valid email, and password of at least 8 characters."
      });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO students (name, email, password_hash)
      VALUES (?, ?, ?)
    `).run(name.trim(), normalizedEmail, passwordHash);

    req.session.studentId = Number(result.lastInsertRowid);

    res.status(201).json({
      message: "Registration successful.",
      student: {
        id: Number(result.lastInsertRowid),
        name: name.trim(),
        email: normalizedEmail
      }
    });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    console.error(error);
    res.status(500).json({ error: "Could not register student." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Enter email and password." });
    }

    const student = db.prepare(`
      SELECT id, name, email, password_hash
      FROM students
      WHERE email = ?
    `).get(email.trim().toLowerCase());

    if (!student || !(await bcrypt.compare(password, student.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    req.session.studentId = student.id;

    res.json({
      message: "Login successful.",
      student: {
        id: student.id,
        name: student.name,
        email: student.email
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not log in." });
  }
});

app.get("/api/me", (req, res) => {
  if (!req.session.studentId) {
    return res.status(401).json({ error: "Please log in." });
  }

  const student = db.prepare(`
    SELECT id, name, email, created_at
    FROM students
    WHERE id = ?
  `).get(req.session.studentId);

  if (!student) {
    return res.status(401).json({ error: "Please log in again." });
  }

  res.json({ student });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ error: "Could not log out." });
    }

    res.clearCookie("connect.sid");
    res.json({ message: "Logged out successfully." });
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", backend: "CareerPilot API" });
});

app.get("/api/jobs", async (req, res) => {
  try {
    const response = await fetch(
      "https://remotive.com/api/remote-jobs?limit=20"
    );

    if (!response.ok) {
      throw new Error("Job service is unavailable");
    }

    const data = await response.json();

    const jobs = data.jobs.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location || "Remote",
      category: job.category,
      jobType: job.job_type || "Not specified",
      description: job.description,
      url: job.url,
      source: "Remotive",
      postedAt: job.publication_date
    }));

    res.json({
      success: true,
      source: "Remotive",
      count: jobs.length,
      jobs
    });
  } catch (error) {
    console.error("Jobs API error:", error.message);

    res.status(502).json({
      success: false,
      error: "Unable to load live jobs right now. Please try again later."
    });
  }
});


app.get("/api/company-jobs", async (req, res) => {
  try {
    const companyNames = {
      TCS: "Tata Consultancy Services",
      Infosys: "Infosys",
      Wipro: "Wipro",
      Accenture: "Accenture",
      Cognizant: "Cognizant"
    };

    const requestedCompany = String(req.query.company || "");
    const company = companyNames[requestedCompany];

    if (!company) {
      return res.status(400).json({
        success: false,
        error: "Choose a supported company."
      });
    }

    const apiUrl = new URL(
      "https://remotive.com/api/remote-jobs"
    );

    apiUrl.searchParams.set("company_name", company);
    apiUrl.searchParams.set("limit", "10");

    const response = await fetch(apiUrl);

    if (!response.ok) {
      throw new Error("Remotive job service is unavailable");
    }

    const data = await response.json();

    const jobs = (data.jobs || []).map(job => ({
      id: job.id,
      title: job.title,
      company: job.company_name,
      location: job.candidate_required_location || "Remote",
      category: job.category || "General",
      jobType: job.job_type || "Not specified",
      description: job.description || "",
      url: job.url,
      source: "Remotive",
      postedAt: job.publication_date
    }));

    res.json({
      success: true,
      source: "Remotive",
      company,
      count: jobs.length,
      jobs
    });
  } catch (error) {
    console.error("Company jobs API error:", error.message);

    res.status(502).json({
      success: false,
      error: "Unable to load company jobs right now."
    });
  }
});


const Groq = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.post("/api/assistant", async (req, res) => {
  try {
    const { message } = req.body;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please enter a question."
      });
    }

    if (message.length > 4000) {
      return res.status(400).json({
        success: false,
        error: "Please keep your question under 4000 characters."
      });
    }

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      messages: [
        {
          role: "system",
          content: "You are CareerPilot AI, a friendly career guidance assistant. Help students with career choices, job skills, resumes, interviews, learning roadmaps, and placements. Give practical, beginner-friendly answers. For multi-day plans, include every requested day, use 2-3 concise bullet points per day, and finish the complete answer. Do not guarantee jobs."
        },
        {
          role: "user",
          content: message.trim()
        }
      ],
      max_tokens: 2500,
      temperature: 0.7
    });
console.log("AI finish reason:", completion.choices[0]?.finish_reason);
console.log("AI response length:", completion.choices[0]?.message?.content?.length);
    res.json({
      success: true,
      reply: completion.choices[0]?.message?.content ||
        "Sorry, I could not generate a response. Please try again."
    });
  } catch (error) {
    console.error(
      "CareerPilot AI error:",
      error.status || error.message
    );

    res.status(502).json({
      success: false,
      error: "The AI assistant is temporarily unavailable. Please try again."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CareerPilot server running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
