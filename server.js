import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// -------------------------------
// Razorpay Initialization
// -------------------------------
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY,
    key_secret: process.env.RAZORPAY_SECRET
});

// -------------------------------
// Create Order API
// -------------------------------
app.post("/create-order", async (req, res) => {
    try {
        const { productURL, selectedSize, quantity } = req.body;

        if (!productURL || !selectedSize || !quantity) {
            return res.json({ success: false, error: "Missing parameters" });
        }

        // Fetch Google Sheet Data
        const sheetURL =
            "https://opensheet.elk.sh/1WI87R6lN_IJPy36_-FjRx4ZE8dATxtZHaV0rwIMSve4/Sheet1";

        const response = await fetch(sheetURL);
        const sheetData = await response.json();

        // -----------------------------
        // FIXED MATCHING LOGIC
        // -----------------------------
        const match = sheetData.find(item =>
            (item.Link || "").trim() === productURL.trim() &&
            (item.Size || "").toLowerCase().includes(selectedSize.toLowerCase()) // FIXED
        );

        if (!match) {
            return res.json({
                success: false,
                error: "product with selected size not found in Google sheet"
            });
        }

        const price = parseInt(match.Price);
        if (!price) {
            return res.json({ success: false, error: "Invalid price in sheet" });
        }

        const finalAmount = price * Number(quantity);
        const amountInPaise = finalAmount * 100;

        // Razorpay Create Order
        const razorpayOrder = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: "AW" + Date.now()
        });

        res.json({
            success: true,
            orderId: razorpayOrder.id,
            amountInPaise
        });

    } catch (err) {
        console.error(err);
        res.json({ success: false, error: "Server error" });
    }
});

// -------------------------------
// Payment Verification
// -------------------------------
app.post("/verify-payment", async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
            req.body;

        const generatedSignature = crypto
            .createHmac("sha256", process.env.RAZORPAY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        if (generatedSignature === razorpay_signature) {
            return res.json({ success: true });
        } else {
            return res.json({ success: false });
        }
    } catch (error) {
        console.error(error);
        res.json({ success: false });
    }
});

// -------------------------------
// Start Server
// -------------------------------
app.listen(3000, () => {
    console.log("Server running on port 3000");
});
