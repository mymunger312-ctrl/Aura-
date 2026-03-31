import express from "express";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Duplicate payment temporary memory store (Render free tier)
global.paid = global.paid || {};

app.post("/verify-payment", async (req, res) => {
  try {
    const {
      orderId,
      amount,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature
    } = req.body;

    // 1) Razorpay signature verification
    const expectedSign = crypto
      .createHmac("sha256", process.env.RAZORPAY_SECRET)
      .update(orderId + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSign !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        reason: "INVALID_SIGNATURE"
      });
    }

    // 2) Duplicate payment protection
    if (global.paid[razorpay_payment_id]) {
      return res.status(409).json({
        success: false,
        reason: "DUPLICATE_PAYMENT"
      });
    }
    global.paid[razorpay_payment_id] = true;

    // 3) Log server record
    console.log("PAYMENT VERIFIED:", req.body);

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({
      success: false,
      reason: "SERVER_ERROR",
      error: err.toString()
    });
  }
});

app.listen(10000, () => {
  console.log("Auraa secure backend running on port 10000");
});
