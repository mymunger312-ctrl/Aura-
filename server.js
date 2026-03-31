const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const API_TOKEN = "AW_SECURE_TOKEN_2026";

const app = express();
app.use(express.json());
app.use(cors());

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30
});
app.use(limiter);

const usedPayments = new Set();
const recentOrders = new Map();

const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET
});

/* ✅ CREATE ORDER */
app.post("/create-order", async (req, res) => {
  if (req.headers["x-token"] !== API_TOKEN)
    return res.status(403).send("Blocked");

  try {
    const { productId, qty } = req.body;

    const price = getPriceFromDB(productId);
    const amount = price * qty;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR"
    });

    res.json(order);
  } catch (err) {
    res.status(500).send("Error");
  }
});

/* ✅ VERIFY PAYMENT */
app.post("/verify-payment", async (req, res) => {
  if (req.headers["x-token"] !== API_TOKEN)
    return res.status(403).send("Blocked");

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId,
      customer
    } = req.body;

    const sign = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (sign !== razorpay_signature) {
      return res.send("Fake payment");
    }

    if (usedPayments.has(razorpay_payment_id)) {
      return res.send("Duplicate payment");
    }

    usedPayments.add(razorpay_payment_id);

    const order = await razorpay.orders.fetch(razorpay_order_id);

    if (!order) return res.send("Invalid order");

    saveOrderToSheet(customer, razorpay_payment_id);

    res.send("OK");

  } catch (err) {
    res.status(500).send("Error");
  }
});

/* ✅ COD */
app.post("/place-cod", (req, res) => {
  if (req.headers["x-token"] !== API_TOKEN)
    return res.status(403).send("Blocked");

  const { customer } = req.body;

  const last = recentOrders.get(customer.phone);
  if (last && Date.now() - last < 5 * 60 * 1000) {
    return res.send("Too many orders");
  }

  recentOrders.set(customer.phone, Date.now());

  saveOrderToSheet(customer, "COD");

  res.send("OK");
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);

function getPriceFromDB(productId){
  return 499;
}

function saveOrderToSheet(customer, paymentId){
  console.log("SAVE:", customer, paymentId);
                                }
