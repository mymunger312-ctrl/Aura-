import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function verifyAdmin(req,res,next){
  const token = req.headers.authorization;

  if(token !== ADMIN_TOKEN){
    return res.status(403).json({ error:"Unauthorized" });
  }

  next();
}

const app = express();
const allowedOrigins = [
  "https://aurawardrobe.blogspot.com",
  "https://aurawardrobe.in",
  "https://www.aurawardrobe.in",
  "https://vocal-fairy-493420.netlify.app"
];

app.use(cors({
  origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(allowedOrigins.includes(origin)){
      return callback(null, true);
    }
    return callback(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type"]
}));

app.set("trust proxy", 1);
app.use(express.json());

// RAZORPAY
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ---------------- FETCH PRODUCT ----------------
async function getProduct(url){
  const { data } = await supabase
    .from("products")
    .select("*")
    .eq("link", url.split("?")[0])
    .single();

  return data;
}

// ---------------- GET PRICE ----------------
function getPrice(product, size){
  if(
    !product ||
    !Array.isArray(product.sizes) ||
    !Array.isArray(product.prices)
  ){
    return null;
  }

  let sizes = product.sizes.map(s =>
    String(s).toLowerCase().trim()
  );

  let prices = product.prices.map(p =>
    Number(p)
  );

  let index = sizes.indexOf(
    String(size).toLowerCase().trim()
  );

  return index >= 0
    ? prices[index]
    : null;
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

// ---------------- CREATE ORDER (ONLINE) ----------------
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

// ---------------- VERIFY PAYMENT ----------------
app.post("/verify-payment", async(req,res)=>{

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

  let body = razorpay_order_id+"|"+razorpay_payment_id;

  let expected = crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET)
  .update(body).digest("hex");

  if(expected !== razorpay_signature){
    return res.json({success:false});
  }

  let product = await getProduct(productURL);
let price = getPrice(product,selectedSize);

let order = await razorpay.orders.fetch(razorpay_order_id);
let final = order.amount / 100;

  // 🔥 CALCULATE DISCOUNTED PER PIECE
  let discountedPerPiece = perPiece(final, quantity);

  // SAVE ORDER
  await supabase.from("orders").insert([{
  order_id: "AW"+Date.now(),
  name,
  email,
  phone,
  address,
  product_url: productURL,
  product_name: productName,
  image,
  size: selectedSize,
  quantity,
  base_price: price,
  per_piece_price: discountedPerPiece,
  total_price: final,
  payment_method: "Online",
  payment_status: "Paid"
}]);

  res.json({success:true});
});

// ---------------- COD ORDER (FULLY SECURE) ----------------
app.post("/create-cod-order", async(req,res)=>{

  try{

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

    await supabase.from("orders").insert([{
  order_id: "AW"+Date.now(),
  name,
  email,
  phone,
  address,
  product_url: productURL,
  product_name: productName,
  image,
  size: selectedSize,
  quantity,
  base_price: price,
  per_piece_price: discountedPerPiece,
  total_price: final,
  payment_method: "COD",
  payment_status: "COD"
}]);

    return res.json({success:true});

  }catch(e){
    console.log("COD ERROR", e);
    return res.json({success:false});
  }

});


app.post("/review", async (req,res)=>{
  let {orderId, rating, review, email, productURL, image} = req.body;

  let { data:existing } = await supabase
    .from("reviews")
    .select("*")
    .eq("order_id", orderId);

  if(existing.length > 0){
    return res.json({status:"duplicate"});
  }

  await supabase.from("reviews").insert([{
    order_id:orderId,
    product_url:productURL,
    rating,
    review,
    email,
    username:email.split("@")[0],
    image_url:image
  }]);

  res.json({status:"success"});
});

app.post("/admin-add-review", verifyAdmin, async (req, res) => {
  try {

    let {
      name,
      rating,
      review,
      product_url,
      image_url
    } = req.body;

    await supabase.from("reviews").insert([{
      product_url,
      rating: Number(rating),
      review,
      username: name,
      email: "admin@aurawardrobe.in",
      image_url: image_url || ""
    }]);

    res.json({ success: true });

  } catch (e) {
    console.log("ADMIN REVIEW ERROR:", e);
    res.json({
      success: false,
      error: e.message
    });
  }
});

app.post("/admin-update-order", verifyAdmin, async(req,res)=>{
  let {order_id, status, message} = req.body;

  await supabase
    .from("orders")
    .update({
      status,
      custom_message: message
    })
    .eq("order_id", order_id);

  res.json({success:true});
});


app.get("/admin-orders", verifyAdmin, async(req,res)=>{
  let { data } = await supabase.from("orders").select("*").order("created_at",{ascending:false});
  res.json(data);
});

app.get("/products", async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.get("/", (req,res)=>res.send("Server running"));
app.listen(process.env.PORT||5000);
