// /api/request-access.js
export default async function handler(req, res) {
  try {
    // CORS (optional, safe for same-origin)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

    const body = typeof req.body === "string" ? safeJsonParse(req.body) : req.body;
    const email = (body?.email || "").trim();
    const company = (body?.company || "").trim();
    const plan = (body?.plan || "").trim();
    const source = (body?.source || "unknown").trim();
    const ts = (body?.ts || new Date().toISOString()).trim();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Valid email is required" });
    }
    if (!company) {
      return res.status(400).json({ ok: false, error: "Company is required" });
    }
    if (!plan) {
      return res.status(400).json({ ok: false, error: "Plan is required" });
    }

    // Log always (so you can see requests even if SMTP isn't configured yet)
    console.log("[AIVI Access Request]", {
      email,
      company,
      plan,
      source,
      ts,
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
      ua: req.headers["user-agent"] || "unknown",
    });

    // If SMTP is configured, email the request to you
    const canSend =
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS &&
      process.env.SMTP_FROM &&
      process.env.SMTP_TO;

    if (canSend) {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const subject = `AIVI access request — ${plan}`;
      const text =
        `New AIVI access request\n\n` +
        `Plan: ${plan}\n` +
        `Work email: ${email}\n` +
        `Company: ${company}\n` +
        `Source: ${source}\n` +
        `Timestamp: ${ts}\n\n` +
        `— Sent from /api/request-access`;

      await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to: process.env.SMTP_TO,
        replyTo: email,
        subject,
        text,
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[AIVI Request Access Error]", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}
