#!/usr/bin/env node
/**
 * Publish one owner-scoped report and its private downloadable file.
 * Requires DATABASE_URL, CLERK_SECRET_KEY, BLOB_READ_WRITE_TOKEN.
 *
 * Usage:
 * node scripts/publish_client_report.mjs <clerk-user-id> <verified-email> <title> <report-type> <file-path> [summary]
 */
import { createClerkClient } from "@clerk/backend";
import { put, del } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import fs from "node:fs/promises";
import path from "node:path";

const [userId, emailInput, titleInput, typeInput, inputPath, summaryInput] = process.argv.slice(2);
if (!userId || !emailInput || !titleInput || !typeInput || !inputPath) {
  console.error("Usage: node scripts/publish_client_report.mjs <clerk-user-id> <verified-email> <title> <report-type> <file-path> [summary]");
  process.exit(2);
}
for (const key of ["DATABASE_URL", "CLERK_SECRET_KEY", "BLOB_READ_WRITE_TOKEN"]) {
  if (!process.env[key]) {
    console.error(key + " is required in the local environment.");
    process.exit(2);
  }
}
const email = String(emailInput).trim().toLowerCase();
const title = String(titleInput).trim();
const reportType = String(typeInput).trim().toLowerCase();
const summary = String(summaryInput || "Private client deliverable attached.").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || title.length < 3 || title.length > 180 ||
    !/^[a-z][a-z0-9_-]{1,39}$/.test(reportType) || summary.length > 2000) {
  console.error("Invalid email, title, report type, or summary.");
  process.exit(2);
}

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const user = await clerk.users.getUser(userId);
const verifiedEmails = (user.emailAddresses || [])
  .filter((entry) => entry.verification && entry.verification.status === "verified")
  .map((entry) => String(entry.emailAddress || "").trim().toLowerCase());
if (!verifiedEmails.includes(email)) {
  console.error("The supplied email is not verified on the specified Clerk account. No report was published.");
  process.exit(2);
}

const filePath = path.resolve(inputPath);
const fileName = path.basename(filePath);
const contentTypes = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const contentType = contentTypes[path.extname(fileName).toLowerCase()];
if (!contentType || /[\r\n]/.test(fileName) || fileName.length > 180) {
  console.error("Supported private report files: PDF, ZIP, DOCX, XLSX. Filename must be 1–180 characters.");
  process.exit(2);
}
const bytes = await fs.readFile(filePath);
if (bytes.length < 1 || bytes.length > 25 * 1024 * 1024) {
  console.error("Report file must be between 1 byte and 25 MiB.");
  process.exit(2);
}

const blob = await put(
  "reports/" + userId + "/" + Date.now() + "-" + fileName,
  new Blob([bytes], { type: contentType }),
  {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: true,
    contentType,
    cacheControlMaxAge: 60,
  }
);
const sql = neon(process.env.DATABASE_URL);
let reportId = null;
try {
  const inserted = await sql.query(
    "INSERT INTO workspace_reports " +
    "(owner_clerk_user_id, owner_email, title, report_type, score, summary, findings, recommendations, action_plan, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, NULL, $5, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now(), now()) RETURNING id",
    [userId, email, title, reportType, summary]
  );
  if (!inserted.length) throw new Error("Report insert returned no ID.");
  reportId = inserted[0].id;
  await sql.query(
    "INSERT INTO private_report_files (report_id, owner_clerk_user_id, blob_pathname, file_name, content_type, size_bytes, active, created_at, updated_at) " +
    "VALUES ($1, $2, $3, $4, $5, $6, TRUE, now(), now())",
    [reportId, userId, blob.pathname, fileName, contentType, bytes.length]
  );
} catch (error) {
  if (reportId !== null) {
    try { await sql.query("DELETE FROM workspace_reports WHERE id = $1 AND owner_clerk_user_id = $2", [reportId, userId]); } catch (_) {}
  }
  try { await del(blob.pathname, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (_) {}
  console.error("Report publishing failed. Any created report row and uploaded private file were cleaned up where possible.");
  throw error;
}

console.log("Private client report published.");
console.log("Report ID:", reportId);
console.log("Title:", title);
console.log("Owner Clerk ID:", userId);
console.log("File:", fileName);
console.log("Only the matching signed-in Clerk account can download this report from the workspace.");
