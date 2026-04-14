// FlowPilot App Server
// Run with: node server.js OR nodemon server.js

const express = require("express");
const cors = require("cors");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Initialize SQLite database
const dbFile = path.join(__dirname, "projects.db");
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) console.error("Database connection error:", err.message);
  else console.log("Connected to SQLite database.");
});

// Create table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      master_prompt TEXT,
      editor_content TEXT,
      lines_history TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Serve static UI pages
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "flowpilot-app.html"));
});

app.get("/editor", (req, res) => {
  res.sendFile(path.join(__dirname, "editor.html"));
});

// --- REST API for Projects ---

// Get all projects overview
app.get("/api/projects", (req, res) => {
  db.all(`SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ projects: rows });
  });
});

// Get specific project
app.get("/api/projects/:name", (req, res) => {
  db.get(`SELECT * FROM projects WHERE name = ?`, [req.params.name], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ project: row || null });
  });
});

// Create or Update Project
app.post("/api/projects", (req, res) => {
  const { name, master_prompt, editor_content, lines_history } = req.body;
  if (!name) return res.status(400).json({ error: "Project name required" });

  const query = `
    INSERT INTO projects (name, master_prompt, editor_content, lines_history, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      master_prompt = excluded.master_prompt,
      editor_content = excluded.editor_content,
      lines_history = excluded.lines_history,
      updated_at = CURRENT_TIMESTAMP
  `;
  
  db.run(query, [name, master_prompt || "", editor_content || "", JSON.stringify(lines_history || [])], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

// Save partial update (e.g. just saving master_prompt or editor_content)
app.patch("/api/projects/:name", (req, res) => {
  const name = req.params.name;
  const updates = [];
  const params = [];
  
  if (req.body.master_prompt !== undefined) {
    updates.push("master_prompt = ?");
    params.push(req.body.master_prompt);
  }
  if (req.body.editor_content !== undefined) {
    updates.push("editor_content = ?");
    params.push(req.body.editor_content);
  }
  if (req.body.lines_history !== undefined) {
    updates.push("lines_history = ?");
    params.push(JSON.stringify(req.body.lines_history));
  }
  
  if (updates.length === 0) return res.json({ success: true, message: "No updates provided" });

  params.push(name);
  const query = `UPDATE projects SET ${updates.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE name = ?`;
  
  db.run(query, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) {
      // Create if it doesn't exist
      const insertQuery = `INSERT INTO projects (name, master_prompt, editor_content, lines_history) VALUES (?, ?, ?, ?)`;
      db.run(insertQuery, [
        name, 
        req.body.master_prompt || "", 
        req.body.editor_content || "", 
        req.body.lines_history ? JSON.stringify(req.body.lines_history) : "[]"
      ], function(insertErr) {
          if (insertErr) return res.status(500).json({ error: insertErr.message });
          return res.json({ success: true, created: true });
      });
    } else {
      res.json({ success: true, updated: true });
    }
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`
  ╔════════════════════════════════════╗
  ║  FlowPilot App running             ║
  ║  Server: Express & SQLite          ║
  ║  Open in Chrome:                   ║
  ║  http://localhost:${PORT}             ║
  ╚════════════════════════════════════╝
  
  Keep this window open while using the app.
  Press Ctrl+C to stop.
  `);
});
