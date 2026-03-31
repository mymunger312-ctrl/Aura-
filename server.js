// server.js
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

// ------------------------------
// 1) RAZORPAY INITIALIZATION
// ------------------------------
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ------------------------------
// 2) FETCH PRODUCT FROM GOOGLE SHEET USING URL + SIZE
// ------------------------------
async function getProductByURLandSize(productURL, selectedSize) {
    const sheetURL =
        "https://opensheet.elk.sh/1WI87R6lN_IJPy36_-FjRx4ZE8dATxtZHaV0rwIMSve4/Sheet1";

    const sheetData = await (await fetch(sheetURL)).json();

    const product = sheetData.find(
        (p) =>
            (p.Link || "").trim() === productURL.trim() &&
            (p.Size || "").trim().toLowerCase() === selectedSize.trim().toLowerCase()
    );

    return product || null;
}

// ------------------------------
// 3) CALCULATE PRICE BASED ON QUANTITY
// ------------------------------
function applyQuantityDiscount(price, qty) {
    const total = price * qty;

    if (qty === 2) return Math.round(total - total * 0.05);
    if (qty === 3) return Math.round(total - total * 0.07);

    return price; // qty = 1
}

// ------------------------------
// 4) API: CREATE ORDER (COMPLETE SECURE)
// ------------------------------
app.post("/create-order", async (req, res) => {
    try {
        const { productURL, selectedSize, quantity } = req.body;

        if (!productURL || !selectedSize || !quantity) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const product = await getProductByURLandSize(productURL, selectedSize);
        if (!product) {
            return res
                .status(404)
                .json({ error: "Product with selected size not found in Google Sheet" });
        }

        const basePrice = parseInt(product.Price);
        if (isNaN(basePrice)) {
            return res.status(400).json({ error: "Invalid price format in Google Sheet" });
        }

        // FINAL PRICE BASED ON QTY
        const finalAmount = applyQuantityDiscount(basePrice, quantity);

        // Convert to paise
        const amountInPaise = finalAmount * 100;

        // Razorpay order
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: "order_" + Date.now(),
        });

        res.json({
            success: true,
            orderId: order.id,
            amount: finalAmount,
            amountInPaise,
            basePrice,
            quantity,
            selectedSize,
            productURL,
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Server error creating order" });
    }
});

// ------------------------------
// 5) VERIFY PAYMENT
// ------------------------------
app.post("/verify-payment", (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

    if (expectedSignature === razorpay_signature) {
        return res.json({ success: true });
    }

    return res.status(400).json({ success: false });
});

// ------------------------------
app.get("/", (req, res) => {
    res.send("Backend is running");
});

// ------------------------------
const PORT = process.env.PORT || 5000;
app.get("/test", (req, res) => {
  res.send("Server Working Fine ✔️");
});

app.listen(PORT, () => console.log("Server running on port " + PORT));
app.get("/test", async (req, res) => {
    res.json({ message: "Running code version 2" });
});
