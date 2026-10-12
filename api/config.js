const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

module.exports = (req, res) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "Method not allowed" });
  }

  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "";
  const secretKey = process.env.CLERK_SECRET_KEY || "";
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const clerkConfigured = Boolean(publishableKey && secretKey);
  const workspaceReady = clerkConfigured && databaseConfigured;
  const productIds = [
    process.env.DODO_PRODUCT_ID_WORKBOOK_19,
    process.env.DODO_PRODUCT_ID_TOOLKIT_27,
    process.env.DODO_PRODUCT_ID_ASSESSMENT_995,
    process.env.DODO_PRODUCT_ID_AUDIT_9500,
  ].filter(Boolean);

  return json(res, 200, {
    workspaceReady,
    clerkConfigured,
    databaseConfigured,
    paymentsConfigured: Boolean(process.env.DODO_WEBHOOK_SECRET && productIds.length),
    publishableKey: workspaceReady ? publishableKey : null,
    message: workspaceReady
      ? "Workspace services are configured."
      : "Client Workspace setup is incomplete. Sign-in and private reports are not available yet.",
  });
};
