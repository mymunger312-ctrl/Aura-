import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
dotenv.config();
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;
const app = express();
app.use(cors({
  origin: [
    "https://www.aurawardrobe.in",
   "https://aurawardrobe.in", "https://aurawardrobe.blogspot.com"
  ],
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());
app.use(helmet());
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

app.set("trust proxy", 1);

const allowedIPs = ["YOUR_FRONTEND_HOSTING_IP"]; // optional but strong

app.use((req,res,next)=>{
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  // OPTIONAL STRICT MODE (only if static IP known)
  // if(!allowedIPs.includes(ip)){
  //   return res.status(403).json({error:"IP blocked"});
  // }

  next();
});

app.use((req,res,next)=>{
  const referer = req.headers.referer || "";

  if (
    !referer.startsWith("https://www.aurawardrobe.in") &&
    !referer.startsWith("https://aurawardrobe.in")
  ){
    return res.status(403).json({ error: "Invalid referer" });
  }

  next();
});

app.use((req,res,next)=>{
  const ua = req.headers["user-agent"] || "";

  // block scripts / bots / curl / postman
  if(
  !ua ||
  ua.length < 20 ||
  ua.includes("curl") ||
  ua.includes("Postman") ||
  ua.includes("python") ||
  ua.includes("node-fetch") ||
  ua.includes("axios")
){
    return res.status(403).json({ error: "Bot blocked" });
  }

  next();
});

app.use(limiter);

async function fetchProductsSecure(){

  const body = {}; // empty body OK

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");

  const signature = crypto
    .createHmac("sha256", process.env.APPS_SCRIPT_SECRET)
    .update(timestamp + nonce + JSON.stringify(body))
    .digest("hex");

  const res = await fetch("https://script.google.com/macros/s/AKfycbzF4XwyzFoY2wLYIfkn6zzxDGQXbcTZXReYxHOhC_Rov1q0PBomTqyI_KjNYWNJ0qSO/exec",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-signature": signature,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
"x-backend-auth": process.env.INTERNAL_SECRET
    },
    body: JSON.stringify(body)
  });

  return await res.json();
}

// RAZORPAY
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------------- FETCH PRODUCT ----------------
async function getProduct(url){
  const sheet = await fetchProductsSecure();

  return sheet.find(p =>
    (p.Link || "").trim().split("?")[0] === url.trim().split("?")[0]
  );
}

function validateOrderInput(body){
  if(!body.productURL || typeof body.productURL !== "string") return false;
  if(!body.selectedSize || typeof body.selectedSize !== "string") return false;
  if(!body.quantity || isNaN(body.quantity)) return false;
  if(body.quantity > 5) return false; // prevent abuse
  return true;
}

function logEvent(type, data){
  if(process.env.NODE_ENV !== "production"){
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    type,
    data
  }));
}
}
// ---------------- GET PRICE ----------------
function getPrice(product,size){
  let sizes = (product.Size || "").toLowerCase().split(",");
  let prices = (product.Price || "").split(",");

  let i = sizes.indexOf(size);
  return i>=0 ? parseInt(prices[i]) : null;
}

// ---------------- DISCOUNT ----------------
function calc(price,qty){
  let t = price * qty;
  if(qty==2) t *= 0.95;
  if(qty==3) t *= 0.93;
  return Math.round(t);
}

// 🔥 NEW: PER PIECE DISCOUNT CALCULATOR
function perPiece(final, qty){
  return Math.round(final / qty);
}

function signPayload(body){
  const timestamp = Date.now().toString();

  const nonce = crypto.randomBytes(16).toString("hex");

  const signature = crypto
    .createHmac("sha256", APPS_SCRIPT_SECRET)
    .update(timestamp + nonce + JSON.stringify(body))
    .digest("hex");

  return { signature, timestamp, nonce };
}

app.use((req, res, next) => {

  // ✅ allow session creation
  if (req.path === "/init-session") {
    return next();
  }

  const sessionId = req.headers["x-session-id"];
  const signature = req.headers["x-session-signature"];
  const expires = req.headers["x-session-expiry"];

  if (!sessionId || !signature || !expires) {
    return res.status(403).json({ error: "No session" });
  }

  if (Date.now() > Number(expires)) {
    return res.status(403).json({ error: "Session expired" });
  }

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
const ua = req.headers["user-agent"] || "";

const expected = crypto
  .createHmac("sha256", process.env.SESSION_SECRET)
  .update(sessionId + expires + ip + ua)
  .digest("hex");

  if (expected !== signature) {
    return res.status(403).json({ error: "Invalid session" });
  }

  next();
});


// ---------------- CREATE ORDER (ONLINE) ----------------
app.post("/create-order", async(req,res)=>{
if (!req.headers.origin) {
  return res.status(403).json({ error: "Direct access blocked" });
}

// 🔥 STRICT REFERER CHECK (HARD BLOCK)
const referer = req.headers.referer || "";

if (!referer.startsWith("https://www.aurawardrobe.in") &&
    !referer.startsWith("https://aurawardrobe.in")) {
  return res.status(403).json({ error: "Invalid referer" });
}

if(!validateOrderInput(req.body)){
  return res.status(400).json({error:"Invalid input"});
}
logEvent("CREATE_ORDER", req.body);
  let {productURL,selectedSize,quantity}=req.body;

  let product = await getProduct(productURL);
  if(!product) return res.json({error:"Product not found"});

  let price = getPrice(product,selectedSize);
  if(!price) return res.json({error:"Invalid size"});

  let final = calc(price,quantity);

  let order = await razorpay.orders.create({
  amount: final*100,
  currency:"INR",
  receipt: crypto
    .createHash("sha256")
    .update(productURL + selectedSize + quantity)
    .digest("hex")
});

if (!global.orderStore) global.orderStore = new Map();

global.orderStore.set(order.id, {
  productURL,
  selectedSize,
  quantity
});

  res.json({
    success:true,
    orderId:order.id,
    amountInPaise:final*100
  });
});

// ---------------- VERIFY PAYMENT ----------------
app.post("/verify-payment", async(req,res)=>{
if(!validateOrderInput(req.body)){
  return res.status(400).json({error:"Invalid input"});
}
logEvent("VERIFY_PAYMENT_ATTEMPT", req.body);
  let {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    productURL,
    selectedSize,
    quantity,
    name,
    email,
    phone,
    pin,
    landmark,
    house,
    address,
    product:productName,
    image
  } = req.body;

const stored = global.orderStore?.get(razorpay_order_id);

if (!stored) {
  return res.json({ success:false });
}

  let body = razorpay_order_id+"|"+razorpay_payment_id;

  let expected = crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET)
  .update(body).digest("hex");

  if(expected !== razorpay_signature){
logEvent("FAILED_SIGNATURE", req.headers);
    return res.json({success:false});
  }

  if (stored.used) {
  return res.json({ success:false });
}
stored.used = true;

if(!stored){
  return res.json({success:false});
}

let product = await getProduct(stored.productURL);
let price = getPrice(product, stored.selectedSize);
let final = calc(price, stored.quantity);

  let order = await razorpay.orders.fetch(razorpay_order_id);

const expectedReceipt = crypto
  .createHash("sha256")
  .update(productURL + selectedSize + quantity)
  .digest("hex");

if(order.receipt !== expectedReceipt){
  return res.json({success:false});
}

  if(order.amount !== final*100){
    return res.json({success:false});
  }
let payment = await razorpay.payments.fetch(razorpay_payment_id);

if(payment.order_id !== razorpay_order_id){
  return res.json({success:false});
}

if(payment.amount !== final*100){
  return res.json({success:false});
}

if(payment.status !== "captured"){
  return res.json({success:false});
}
  // 🔥 CALCULATE DISCOUNTED PER PIECE
  let discountedPerPiece = perPiece(final, quantity);

  // SAVE ORDER
  const payload = {
  "Order ID":"AW"+Date.now(),
  "Name":name,
  "Email ID":email,
  "Phone":phone,
  "Pin Code":pin,
  "Landmark":landmark,
  "House No /Apartment No /Street No":house,
  "Address":address,
  "Product Title":productName,
  "Product Image":image,
  "Product URL":productURL,
  "Size":selectedSize,
  "Quantity":quantity,
  "Price":discountedPerPiece,
  "Base Price":price,
  "Per Piece Price":discountedPerPiece,
  "Total Price":final,
  "Payment Status":"Paid",
  "Payment Method":"Online"
};

const { signature, timestamp, nonce } = signPayload(payload);

await fetch("https://script.google.com/macros/s/AKfycbx5ObJYnKZ0-CZMj8s65NMM5plyl4Zb151IH9kpz97YpigWh3mXSzCKtwS4KiFsFXkM/exec",{
  method:"POST",
  headers:{
  "Content-Type":"application/json",
  "x-signature": signature,
  "x-timestamp": timestamp,
  "x-nonce": nonce,
"x-backend-auth": process.env.INTERNAL_SECRET
},
  body:JSON.stringify(payload)
});

res.json({success:true}); });

// ---------------- COD ORDER (FULLY SECURE) ----------------
app.post("/create-cod-order", async(req,res)=>{

  try{
if(!validateOrderInput(req.body)){
  return res.status(400).json({error:"Invalid input"});
}
logEvent("CREATE_COD_ORDER", req.body);
// 🔥 GET REAL IP (FIXED)
const ip = (req.headers["x-forwarded-for"] || "")
  .split(",")[0]
  .trim() || req.socket.remoteAddress;

// 🔥 BASIC DEVICE FINGERPRINT (NO FRONTEND CHANGE NEEDED)
const userAgent = req.headers["user-agent"] || "";
const fingerprint = crypto
  .createHash("sha256")
  .update(ip + userAgent + (req.body.phone || "") + (req.body.email || ""))
  .digest("hex");

// 🔥 INIT STORE
if (!global.codMap) global.codMap = {};

// 🔥 INIT USER RECORD
if (!global.codMap[fingerprint]) {
  global.codMap[fingerprint] = {
    count: 0,
    firstAttempt: Date.now()
  };
}

const user = global.codMap[fingerprint];

// 🔥 AUTO RESET AFTER 24 HOURS
if (Date.now() - user.firstAttempt > 24 * 60 * 60 * 1000) {
  user.count = 0;
  user.firstAttempt = Date.now();
}

// 🔥 LIMIT CHECK
if (user.count >= 7) {
  return res.json({ error: "COD limit reached. Try after 24 hours." });
}

// 🔥 INCREMENT
user.count++;

let { otpToken } = req.body;

if(!otpToken){
  return res.status(401).json({error:"OTP required"});
}

    let {
      productURL,
      selectedSize,
      quantity,
      name,
      email,
      phone,
      pin,
      landmark,
      house,
      address,
      product:productName,
      image
    } = req.body;

    let product = await getProduct(productURL);
    if(!product) return res.json({success:false});

    let price = getPrice(product,selectedSize);
    if(!price) return res.json({success:false});

    let finalWithoutCOD = calc(price,quantity);
    let final = finalWithoutCOD + 100;

    // 🔥 PER PIECE DISCOUNT
    let discountedPerPiece = perPiece(finalWithoutCOD, quantity);

   const payload = {
  "Order ID":"AW"+Date.now(),
  "Name":name,
  "Email ID":email,
  "Phone":phone,
  "Pin Code":pin,
  "Landmark":landmark,
  "House No /Apartment No /Street No":house,
  "Address":address,
  "Product Title":productName,
  "Product Image":image,
  "Product URL":productURL,
  "Size":selectedSize,
  "Quantity":quantity,
  "Price":discountedPerPiece,
  "Base Price":price,
  "Per Piece Price":discountedPerPiece,
  "Total Price":final,
  "Payment Status":"COD",
  "Payment Method":"COD"
};

const { signature, timestamp, nonce } = signPayload(payload);

await fetch("https://script.google.com/macros/s/AKfycbx5ObJYnKZ0-CZMj8s65NMM5plyl4Zb151IH9kpz97YpigWh3mXSzCKtwS4KiFsFXkM/exec",{
  method:"POST",
  headers:{
  "Content-Type":"application/json",
  "x-signature": signature,
  "x-timestamp": timestamp,
  "x-nonce": nonce,
"x-backend-auth": process.env.INTERNAL_SECRET
},
  body:JSON.stringify(payload)
});

    return res.json({success:true});

  }catch(e){
    if(process.env.NODE_ENV !== "production"){
  console.log("COD ERROR", e);
}
    return res.json({success:false});
  }

});

app.post("/cancel-order", async (req,res)=>{
  const payload = req.body;

  const { signature, timestamp, nonce } = signPayload(payload);

  await fetch("https://script.google.com/macros/s/AKfycbx5ObJYnKZ0-CZMj8s65NMM5plyl4Zb151IH9kpz97YpigWh3mXSzCKtwS4KiFsFXkM/exec",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "x-signature": signature,
      "x-timestamp": timestamp,
      "x-nonce": nonce,
"x-backend-auth": process.env.INTERNAL_SECRET
    },
    body: JSON.stringify(payload)
  });

  res.json({success:true});
});

app.post("/init-session", (req, res) => {

  const origin = req.headers.origin;

  if(![
    "https://www.aurawardrobe.in",
"https://aurawardrobe.blogspot.com",
    "https://aurawardrobe.in"
  ].includes(origin)){
    return res.status(403).json({ error: "Blocked" });
  }

  const sessionId = crypto.randomBytes(16).toString("hex");

  const expires = Date.now() + (10 * 60 * 1000);

  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

const finalSignature = crypto
  .createHmac("sha256", process.env.SESSION_SECRET)
const ua = req.headers["user-agent"] || "";

.update(sessionId + expires + ip + ua)
  .digest("hex");

res.json({ sessionId, expires, signature: finalSignature });
});

app.get("/", (req,res)=>res.send("Server running"));
app.listen(process.env.PORT||5000);
