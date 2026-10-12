#!/usr/bin/env node
/**
 * Upload one real deliverable to Vercel Private Blob and register its product
 * mapping. Run locally with DATABASE_URL, BLOB_READ_WRITE_TOKEN, and the exact
 * DODO_PRODUCT_ID_* value available in your environment. Never use a public Blob store.
 *
 * Usage: node scripts/upload_private_product.mjs <dodo-product-id> <file-path> [display-name]
 */
import { put, del } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import fs from "node:fs/promises";
import path from "node:path";

const [productId, inputPath, requestedName] = process.argv.slice(2);
const productEnvNames = [
  "DODO_PRODUCT_ID_WORKBOOK_19",
  "DODO_PRODUCT_ID_TOOLKIT_27",
  "DODO_PRODUCT_ID_ASSESSMENT_995",
  "DODO_PRODUCT_ID_AUDIT_9500",
];
const knownProductIds = productEnvNames.map((name) => process.env[name]).filter(Boolean);

if (!productId || !inputPath) {
  console.error("Usage: node scripts/upload_private_product.mjs <dodo-product-id> <file-path> [display-name]");
  process.exit(2);
}
if (!process.env.DATABASE_URL || !process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("DATABASE_URL and BLOB_READ_WRITE_TOKEN are required in the local environment.");
  process.exit(2);
}
if (!knownProductIds.includes(productId)) {
  console.error("The product ID must exactly match one configured DODO_PRODUCT_ID_* environment variable.");
  process.exit(2);
}

const contentTypes = {
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const absolutePath = path.resolve(inputPath);
const extension = path.extname(absolutePath).toLowerCase();
const contentType = contentTypes[extension];
if (!contentType) {
  console.error("Supported deliverables: PDF, ZIP, DOCX, XLSX.");
  process.exit(2);
}

const bytes = await fs.readFile(absolutePath);
const maxBytes = 25 * 1024 * 1024;
if (bytes.length < 1 || bytes.length > maxBytes) {
  console.error("File must be between 1 byte and 25 MiB.");
  process.exit(2);
}

const fileName = path.basename(requestedName || absolutePath).replace(/[\r\n]/g, "").trim();
if (!fileName || fileName.length > 180 || path.basename(fileName) !== fileName) {
  console.error("Display name must be a filename of 1–180 characters, without path components.");
  process.exit(2);
}

const sql = neon(process.env.DATABASE_URL);
const existing = await sql`
  SELECT blob_pathname
  FROM private_product_files
  WHERE product_id = ${productId} AND file_name = ${fileName} AND active = TRUE
  LIMIT 1
`;

const blob = await put(
  `products/${productId}/${fileName}`,
  new Blob([bytes], { type: contentType }),
  {
    access: "private",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: true,
    contentType,
    cacheControlMaxAge: 60,
  }
);

try {
  await sql`
    INSERT INTO private_product_files
      (product_id, blob_pathname, file_name, content_type, size_bytes, active, created_at, updated_at)
    VALUES
      (${productId}, ${blob.pathname}, ${fileName}, ${contentType}, ${bytes.length}, TRUE, now(), now())
    ON CONFLICT (product_id, file_name) WHERE active = TRUE
    DO UPDATE SET
      blob_pathname = EXCLUDED.blob_pathname,
      content_type = EXCLUDED.content_type,
      size_bytes = EXCLUDED.size_bytes,
      updated_at = now()
  `;
} catch (error) {
  console.error("The private blob was uploaded but its database mapping failed. No customer download is enabled for it.");
  console.error("Remove the unreferenced private blob from the Vercel Blob dashboard after investigating.");
  throw error;
}

const oldPath = existing[0] && existing[0].blob_pathname;
if (oldPath && oldPath !== blob.pathname) {
  try {
    await del(oldPath, { token: process.env.BLOB_READ_WRITE_TOKEN });
  } catch (_) {
    console.warn("The previous private blob could not be deleted; it is not referenced by the active mapping.");
  }
}

console.log("Private deliverable registered successfully.");
console.log("Product ID:", productId);
console.log("File name:", fileName);
console.log("Size (bytes):", bytes.length);
console.log("Blob pathname:", blob.pathname);
console.log("The file is served only by the authenticated /api/download endpoint to accounts with an active matching entitlement.");
