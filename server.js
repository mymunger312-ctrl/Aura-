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
// 2) FETCH PRODUCT FROM GOOGLE SHEET
// ------------------------------
async function getProductFromSheet(productName) {
    const sheetURL = "https://opensheet.elk.sh/1WI87R6lN_IJPy36_-FjRx4ZE8dATxtZHaV0rwIMSve4/Sheet1";

    const data = await (await fetch(sheetURL)).json();
    const product = data.find(
        (p) => p.Name.trim().toLowerCase() === productName.trim().toLowerCase()
    );

    if (!product) return null;

    // Split sizes/prices if multiple values
    const priceList = product.Price.split(",").map((p) => p.trim());

    return {
        name: product.Name,
        prices: priceList, // multiple prices based on size
        image: product.Image,
        link: product.Link,
        color: product.Color,
        sizeOptions: product.Size.split(",").map((s) => s.trim())
    };
}

// ------------------------------
// 3) CALCULATE FINAL PRICE
// ------------------------------
function applyQuantityDiscount(amount, qty) {
    if (qty === 2) return Math.round(amount * 0.95); // 5% off
    if (qty >= 3) return Math.round(amount * 0.93); // 7% off
    return amount;
}

// ------------------------------
// 4) API: CREATE ORDER (SAFE)
// ------------------------------
app.post("/create-order", async (req, res) => {
    try {
        const { productName, selectedSize, quantity } = req.body;

        if (!productName || !selectedSize || !quantity)
            return res.status(400).json({ error: "Missing required fields" });

        const product = await getProductFromSheet(productName);
        if (!product)
            return res.status(404).json({ error: "Product not found in Google Sheet" });

        // Identify index of size
        const sizeIndex = product.sizeOptions.indexOf(selectedSize);
        if (sizeIndex === -1)
            return res.status(400).json({ error: "Invalid size selected" });

        // Get price based on size
        const basePrice = parseInt(product.prices[sizeIndex]);
        if (isNaN(basePrice))
            return res.status(400).json({ error: "Invalid price format in Google Sheet" });

        // Price * qty
        let finalAmount = basePrice * quantity;

        // Apply discount
        finalAmount = applyQuantityDiscount(finalAmount, quantity);

        // Convert to paise
        const amountInPaise = finalAmount * 100;

        // Create Razorpay order
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: "receipt_" + Date.now(),
        });

        res.json({
            success: true,
            orderId: order.id,
            amount: finalAmount,
            amountInPaise,
            productName,
            selectedSize,
            quantity
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error creating order" });
    }
});

// ------------------------------
// 5) VERIFY PAYMENT SIGNATURE
// ------------------------------
app.post("/verify-payment", (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const sign = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSign = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(sign)
        .digest("hex");

    if (razorpay_signature === expectedSign) {
        return res.json({ success: true, message: "Payment verified successfully" });
    }

    return res.status(400).json({ success: false, message: "Payment verification failed" });
});

// ------------------------------
app.get("/", (req, res) => {
    res.send("Backend is running");
});

// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
