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

const SECRET = process.env.SECRET_KEY;

// RAZORPAY
const razorpay = new Razorpay({
key_id: process.env.RAZORPAY_KEY_ID,
key_secret: process.env.RAZORPAY_KEY_SECRET
});

// FETCH PRODUCT
async function getProduct(url){
const sheet = await (await fetch("https://opensheet.elk.sh/1WI87R6lN_IJPy36_-FjRx4ZE8dATxtZHaV0rwIMSve4/Sheet1")).json();

return sheet.find(p =>
(p.Link || "").trim().split("?")[0] === url.trim().split("?")[0]
);
}

// GET PRICE
function getPrice(product,size){
let sizes = product.Size.toLowerCase().split(",");
let prices = product.Price.split(",");

let i = sizes.indexOf(size);
return i>=0 ? parseInt(prices[i]) : null;
}

// DISCOUNT
function calc(price,qty){
let t = price*qty;
if(qty==2) t*=0.95;
if(qty==3) t*=0.93;
return Math.round(t);
}

// CREATE ORDER
app.post("/create-order", async(req,res)=>{
let {productURL,selectedSize,quantity}=req.body;

let product = await getProduct(productURL);
if(!product) return res.json({error:"Product not found"});

let price = getPrice(product,selectedSize);
if(!price) return res.json({error:"Invalid size"});

let final = calc(price,quantity);

let order = await razorpay.orders.create({
amount: final*100,
currency:"INR"
});

res.json({
success:true,
orderId:order.id,
amountInPaise:final*100
});
});

// VERIFY PAYMENT + VALIDATE PRICE AGAIN
app.post("/verify-payment", async(req,res)=>{

let {razorpay_order_id,razorpay_payment_id,razorpay_signature,productURL,selectedSize,quantity} = req.body;

let body = razorpay_order_id+"|"+razorpay_payment_id;

let expected = crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET)
.update(body).digest("hex");

if(expected !== razorpay_signature){
return res.json({success:false});
}

// RECHECK PRICE
let product = await getProduct(productURL);
let price = getPrice(product,selectedSize);
let final = calc(price,quantity);

let order = await razorpay.orders.fetch(razorpay_order_id);

if(order.amount !== final*100){
return res.json({success:false});
}

res.json({success:true});
});

// COD VALIDATION
app.post("/create-cod", async(req,res)=>{
let {productURL,selectedSize,quantity}=req.body;

let product = await getProduct(productURL);
let price = getPrice(product,selectedSize);
let final = calc(price,quantity) + 100;

res.json({success:true,amount:final});
});

// SAVE ORDER (SECURE)
app.post("/save-order", async(req,res)=>{

if(req.body.secret !== SECRET){
return res.status(403).send("Unauthorized");
}

await fetch("https://script.google.com/macros/s/AKfycbx5ObJYnKZ0-CZMj8s65NMM5plyl4Zb151IH9kpz97YpigWh3mXSzCKtwS4KiFsFXkM/exec",{
method:"POST",
headers:{ "Content-Type":"application/json" },
body:JSON.stringify(req.body)
});

res.json({success:true});
});

app.listen(process.env.PORT||5000);
