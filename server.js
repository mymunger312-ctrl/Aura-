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
// 2) FETCH PRODUCT FROM GOOGLE SHEET USING URL
// ------------------------------
async function getProduct(productURL) {
    const sheetURL =
        "https://opensheet.elk.sh/1WI87R6lN_IJPy36_-FjRx4ZE8dATxtZHaV0rwIMSve4/Sheet1";

    const sheetData = await (await fetch(sheetURL)).json();

    return sheetData.find(p =>
        (p.Link || "").trim().split("?")[0] === productURL.trim().split("?")[0]
    ) || null;
}

// ------------------------------
// 3) GET PRICE BASED ON SIZE
// ------------------------------
function getPriceBySize(product, selectedSize) {

    const sizes = (product.Size || "")
        .toLowerCase()
        .split(",")
        .map(s => s.trim());

    const prices = (product.Price || "")
        .split(",")
        .map(p => parseInt(p.trim()));

    const index = sizes.indexOf(selectedSize.toLowerCase());

    if (index === -1 || !prices[index] || isNaN(prices[index])) {
        return null;
    }

    return prices[index];
}

// ------------------------------
// 4) APPLY DISCOUNT
// ------------------------------
function applyQuantityDiscount(price, qty) {
    const total = price * qty;

    if (qty === 2) return Math.round(total * 0.95);
    if (qty === 3) return Math.round(total * 0.93);

    return total; // ✅ FIXED
}

// ------------------------------
// 5) CREATE ORDER
// ------------------------------
app.post("/create-order", async (req, res) => {
    try {
        const { productURL, selectedSize, quantity } = req.body;

        // ---------------- VALIDATION ----------------
        if (!productURL || !selectedSize || !quantity) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // ---------------- FETCH PRODUCT ----------------
        const product = await getProduct(productURL);

        if (!product) {
            return res.status(404).json({
                error: "Product not found in Google Sheet"
            });
        }

        // ---------------- GET PRICE ----------------
        const basePrice = getPriceBySize(product, selectedSize);

        if (!basePrice) {
            return res.status(400).json({
                error: "Invalid size or price not found"
            });
        }

        // ---------------- FINAL AMOUNT ----------------
        const finalAmount = applyQuantityDiscount(basePrice, quantity);

        if (!finalAmount || finalAmount <= 0) {
            return res.status(400).json({
                error: "Invalid amount"
            });
        }

        const amountInPaise = finalAmount * 100;

        // ---------------- RAZORPAY ORDER ----------------
        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: "INR",
            receipt: "order_" + Date.now(),
        });

        return res.json({
            success: true,
            orderId: order.id,
            amount: finalAmount,
            amountInPaise,
            basePrice,
            quantity,
            selectedSize,
            productURL
        });

    } catch (error) {
        console.error("CREATE ORDER ERROR:", error);
        return res.status(500).json({
            error: error.message || "Server error creating order"
        });
    }
});

// ------------------------------
// 6) VERIFY PAYMENT
// ------------------------------
app.post("/verify-payment", (req, res) => {
    try {
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

    } catch (err) {
        console.error("VERIFY ERROR:", err);
        return res.status(500).json({ success: false });
    }
});

// ------------------------------
// ROOT
// ------------------------------
app.get("/", (req, res) => {
    res.send("Backend is running");
});

// ------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log("Server running on port " + PORT));
