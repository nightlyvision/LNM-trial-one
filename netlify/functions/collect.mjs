import { randomUUID } from "node:crypto";

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

function getCommonConfig() {
  const env = process.env.MPESA_ENV || "sandbox";
  if (!['sandbox', 'production'].includes(env)) throw new Error("MPESA_ENV must be sandbox or production.");
  const baseUrl = env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
  const required = ["MPESA_CONSUMER_KEY", "MPESA_CONSUMER_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Set these Netlify function environment variables: ${missing.join(", ")}`);
  return { env, baseUrl };
}

function getConfig() {
  const config = getCommonConfig();
  const required = ["MPESA_STK_SHORTCODE", "MPESA_PASSKEY", "MPESA_CALLBACK_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Set these Netlify function environment variables: ${missing.join(", ")}`);
  return { ...config, shortcode: process.env.MPESA_STK_SHORTCODE };
}

async function getAccessToken(config) {
  const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
  const url = `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Daraja authentication failed (HTTP ${res.status}).`);
  return data.access_token;
}

function stkPassword(shortcode) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString("base64");
  return { timestamp, password };
}

async function startPhonePayment(payload) {
  const config = getConfig();
  const phone = normalizeKenyanPhone(payload.payer);
  const token = await getAccessToken(config);
  const { timestamp, password } = stkPassword(config.shortcode);
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

async function queryPhonePayment(checkoutRequestId) {
  const config = getConfig();
  const token = await getAccessToken(config);
  const { timestamp, password } = stkPassword(config.shortcode);
  const res = await fetch(`${config.baseUrl}/mpesa/stkpushquery/v1/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`STK status query failed (HTTP ${res.status}).`);
  if (data.ResultCode === undefined) return { status: "pending", description: data.ResponseDescription || "Waiting for payer approval." };
  if (String(data.ResultCode) === "0") return { status: "paid", description: data.ResultDesc || "Payment completed." };
  return { status: "failed", description: data.ResultDesc || "Payment was not completed." };
}

async function startTillPayment(payload) {
  const config = getCommonConfig();
  const payerTill = String(payload.payer || "").replace(/\D/g, "");
  if (!/^\d{5,8}$/.test(payerTill)) throw new Error("Enter the paying till number (5 to 8 digits).");
  const receiver = process.env.MPESA_B2B_RECEIVER_SHORTCODE;
  const partnerName = process.env.MPESA_B2B_PARTNER_NAME;
  const callbackUrl = process.env.MPESA_B2B_CALLBACK_URL;
  const missing = [
    ["MPESA_B2B_RECEIVER_SHORTCODE", receiver],
    ["MPESA_B2B_PARTNER_NAME", partnerName],
    ["MPESA_B2B_CALLBACK_URL", callbackUrl],
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw new Error(`Set these Netlify function environment variables: ${missing.join(", ")}`);

  const token = await getAccessToken(config);
  const requestBody = {
    primaryShortCode: payerTill,
    receiverShortCode: receiver,
    amount: fixedAmount,
    paymentRef: "PAYMENT",
    callbackUrl,
    partnerName,
    requestRefId: randomUUID(),
  };
  const res = await fetch(`${config.baseUrl}/v1/ussdpush/get-msisdn`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`B2B Express Checkout failed (HTTP ${res.status}): ${data.message || data.error || "Daraja returned an error."}`);
  return data;
}

export default async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method === "GET") {
    const checkoutRequestId = new URL(request.url).searchParams.get("checkoutRequestId");
    if (!checkoutRequestId) return response({ error: "checkoutRequestId is required." }, 400);
    try { return response(await queryPhonePayment(checkoutRequestId)); }
    catch (error) { return response({ error: error.message }, 502); }
  }
  if (request.method !== "POST") return response({ error: "POST or GET only" }, 405);

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

  // B2B Express Checkout sends its final asynchronous outcome to this callback.
  // The exact callback schema should be confirmed with Safaricom for the live app.
  if (!body.method) {
    console.log("B2B Express Checkout callback", JSON.stringify({
      topLevelKeys: Object.keys(body),
      resultCode: body.ResultCode ?? body.resultCode ?? body.Result?.ResultCode,
      status: body.Status ?? body.status,
      transactionId: body.TransactionID ?? body.Result?.TransactionID,
      requestRefId: body.RequestRefID ?? body.requestRefId,
    }));
    return response({ ResultCode: 0, ResultDesc: "Success" });
  }

  if (body.method === "till") {
    try {
      const result = await startTillPayment(body);
      return response({
        message: "B2B Express Checkout request sent. The till operator must approve it; this acknowledgement is not payment confirmation.",
        code: result.code,
        status: result.status,
        requestRefId: result.requestRefId,
      });
    } catch (error) {
      console.error("B2B Express Checkout error:", error.message);
      return response({ error: error.message }, 502);
    }
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
