const express = require("express");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// 🔐 USE ENV VARIABLES (IMPORTANT)
const razorpay = new Razorpay({
  key_id: process.env.KEY_ID,
  key_secret: process.env.KEY_SECRET
});

// ✅ CREATE ORDER
app.post("/create-order", async (req, res) => {
  try {
    const { amount, receipt } = req.body;

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: receipt
    });

    res.json(order);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// ✅ VERIFY PAYMENT
app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    const generated_signature = crypto
      .createHmac("sha256", process.env.KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature === razorpay_signature) {
      res.json({ status: "verified" });
    } else {
      res.json({ status: "failed" });
    }
  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

app.listen(3000, () => console.log("Server running"));
