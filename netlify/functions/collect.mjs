const fixedAmount = 10;
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

function normalizeKenyanPhone(value) {
  const digits = String(value || "").replace(/[\s+()-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  throw new Error("Enter a valid Kenyan M-Pesa phone number.");
}

function getConfig() {
  const env = process.env.MPESA_ENV || "sandbox";
  if (!['sandbox', 'production'].includes(env)) throw new Error("MPESA_ENV must be sandbox or production.");
  const baseUrl = env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
  const required = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET", "MPESA_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Set these Netlify function environment variables: ${missing.join(", ")}`);
  return { env, baseUrl, shortcode: process.env.MPESA_SHORTCODE };
}

async function getAccessToken(config) {
  const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const url = `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Daraja authentication failed (HTTP ${res.status}).`);
  return data.access_token;
}

async function startPhonePayment(payload) {
  const config = getConfig();
  const phone = normalizeKenyanPhone(payload.payer);
  const token = await getAccessToken(config);
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const password = Buffer.from(`${config.shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString("base64");
  const requestBody = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerBuyGoodsOnline",
    Amount: fixedAmount,
    PartyA: phone,
    PartyB: config.shortcode,
    PhoneNumber: phone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: "PAYMENT",
    TransactionDesc: "Payment",
  };
  const res = await fetch(`${config.baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`STK Push request failed (HTTP ${res.status}): ${data.errorMessage || data.ResponseDescription || "Daraja returned an error."}`);
  return data;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return response({ error: "POST only" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return response({ error: "Request body must be valid JSON." }, 400); }

  // Daraja sends the asynchronous STK result to this same function URL.
  if (body?.Body?.stkCallback) {
    const callback = body.Body.stkCallback;
    const items = callback.CallbackMetadata?.Item || [];
    const metadata = Object.fromEntries(items.map((item) => [item.Name, item.Value]));
    console.log("STK callback", JSON.stringify({
      resultCode: callback.ResultCode,
      resultDescription: callback.ResultDesc,
      checkoutRequestId: callback.CheckoutRequestID,
      receipt: metadata.MpesaReceiptNumber,
      amount: metadata.Amount,
      phone: metadata.PhoneNumber,
    }));
    return response({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  if (body.method === "till") {
    return response({
      error: "B2B Express Checkout is not wired yet.",
      next: "Confirm the B2B Express Checkout product is enabled, then use the request schema and callback fields shown in its authenticated Daraja portal documentation. Do not use B2B payment-request credentials or payload as a substitute.",
    }, 501);
  }
  if (body.method !== "phone") return response({ error: "method must be phone or till." }, 400);

  try {
    const result = await startPhonePayment(body);
    return response({
      message: "Daraja accepted the STK Push request. This is not final payment confirmation; wait for the callback.",
      merchantRequestId: result.MerchantRequestID,
      checkoutRequestId: result.CheckoutRequestID,
      responseCode: result.ResponseCode,
      responseDescription: result.ResponseDescription,
    });
  } catch (error) {
    console.error("Payment initiation error:", error.message);
    return response({ error: error.message }, 502);
  }
};
