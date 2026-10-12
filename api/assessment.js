const { verifyToken, createClerkClient } = require("@clerk/backend");
const { neon } = require("@neondatabase/serverless");

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, private");
  res.end(JSON.stringify(body));
};

const QUESTIONS = [
  {
    title: "Warm-lead follow-up",
    prompt: "How often do warm leads go quiet without explanation?",
    labels: { 20: "Rarely", 50: "Sometimes", 80: "Often" },
    recommendation: "Review follow-up ownership and response-time expectations for warm leads.",
  },
  {
    title: "Post-proposal handoff",
    prompt: "Do you know exactly what happens to a deal in the week after a proposal goes out?",
    labels: { 20: "Always", 50: "Mostly", 80: "Not really" },
    recommendation: "Map the first seven days after proposal delivery and define the next-step owner.",
  },
  {
    title: "Renewal warning signals",
    prompt: "Has a client ever left, and it felt like a surprise?",
    labels: { 20: "Never", 50: "Once or twice", 80: "More than that" },
    recommendation: "Add early-warning checkpoints to renewal and customer-health reviews.",
  },
];

async function getIdentity(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const claims = await verifyToken(match[1], {
    secretKey: process.env.CLERK_SECRET_KEY,
  });
  if (!claims || !claims.sub) return null;

  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const user = await clerk.users.getUser(claims.sub);
  const verified = (user.emailAddresses || []).filter(
    (entry) => entry.verification && entry.verification.status === "verified"
  );
  const emails = verified
    .map((entry) => String(entry.emailAddress || "").trim().toLowerCase())
    .filter(Boolean);
  const primary = verified.find((entry) => entry.id === user.primaryEmailAddressId);
  return {
    userId: claims.sub,
    ownerEmail: primary ? String(primary.emailAddress).trim().toLowerCase() : (emails[0] || null),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Method not allowed" });
  }

  if (process.env.WORKSPACE_ENABLED !== "true" ||
      !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||
      !process.env.CLERK_SECRET_KEY || !process.env.DATABASE_URL) {
    return json(res, 503, {
      code: "WORKSPACE_NOT_CONFIGURED",
      message: "Saving previews is not available yet. Your public assessment still works without signing in.",
    });
  }

  let identity;
  try {
    identity = await getIdentity(req);
  } catch (_) {
    return json(res, 401, { error: "A valid sign-in session is required to save this preview." });
  }
  if (!identity) return json(res, 401, { error: "A valid sign-in session is required to save this preview." });

  let body = req.body;
  if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString("utf8")); } catch (_) { body = null; }
  } else if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = null; }
  }

  const answers = body && body.answers;
  const requestId = String(body && body.requestId || "");
  if (!Array.isArray(answers) || answers.length !== 3 ||
      answers.some((value) => ![20, 50, 80].includes(value)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    return json(res, 400, { error: "Please complete all three preview questions and try again." });
  }

  const score = Math.round(answers.reduce((sum, value) => sum + value, 0) / answers.length);
  const findings = QUESTIONS.map((question, index) => ({
    title: question.title,
    description: "Your response: " + question.labels[answers[index]] + ". This is self-reported input, not independently verified evidence.",
  }));
  const recommendations = QUESTIONS
    .filter((question, index) => answers[index] >= 50)
    .map((question) => ({ title: question.recommendation }));
  if (!recommendations.length) {
    recommendations.push({
      title: "Keep reviewing recent pipeline, proposal, and renewal records to validate that the current process is working as expected.",
    });
  }
  const actionPlan = [
    { title: "Review recent examples from each of the three questions." },
    { title: "Confirm process ownership and the evidence available in your CRM or operating records." },
    { title: "Choose one improvement to test, then review the result against a defined baseline." },
  ];
  const summary = "Directional preview score: " + score + "/100, based only on three self-reported answers. This is not a full diagnosis, a verified finding, a revenue forecast, or a guarantee.";

  try {
    const sql = neon(process.env.DATABASE_URL);
    const inserted = await sql`
      INSERT INTO workspace_reports
        (owner_clerk_user_id, owner_email, title, report_type, score, summary,
         findings, recommendations, action_plan, source_request_id, created_at, updated_at)
      VALUES
        (${identity.userId}, ${identity.ownerEmail}, 'Revenue Leak Score preview',
         'preview', ${score}, ${summary}, ${JSON.stringify(findings)}::jsonb,
         ${JSON.stringify(recommendations)}::jsonb, ${JSON.stringify(actionPlan)}::jsonb,
         ${requestId}, now(), now())
      ON CONFLICT (owner_clerk_user_id, source_request_id)
        WHERE source_request_id IS NOT NULL
      DO NOTHING
      RETURNING id, title, report_type, score, summary, created_at
    `;

    if (inserted.length) return json(res, 201, { report: inserted[0], saved: true });

    const existing = await sql`
      SELECT id, title, report_type, score, summary, created_at
      FROM workspace_reports
      WHERE owner_clerk_user_id = ${identity.userId}
        AND source_request_id = ${requestId}
      LIMIT 1
    `;
    if (existing.length) return json(res, 200, { report: existing[0], saved: true, duplicate: true });
    return json(res, 500, { error: "The preview could not be saved. Please try again." });
  } catch (_) {
    return json(res, 503, {
      code: "WORKSPACE_TEMPORARILY_UNAVAILABLE",
      message: "The preview could not be saved. Your answers have not been confirmed as saved.",
    });
  }
};
