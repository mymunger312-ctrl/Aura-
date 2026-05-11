import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------- GOOGLE SHEET SYNC ----------------

async function syncOrderToSheet(orderData){

  try{

    await fetch(process.env.GOOGLE_SHEET_WEBHOOK,{
      method:"POST",
      headers:{
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        order_id: orderData.order_id,
        email: orderData.email,
        product_url: orderData.product_url,
        status: orderData.status || "Processing"
      })
    });

  }catch(e){

    console.log("GOOGLE SHEET SYNC ERROR:", e);

  }

}

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
  "https://grand-narwhal-9cd58a.netlify.app"
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
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ limit: "15mb", extended: true }));

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

async function getEmbedding(text){
  const res = await fetch("https://api.openai.com/v1/embeddings",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization":`Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model:"text-embedding-3-small",
      input:text
    })
  });

  const json = await res.json();

  // ✅ SAFETY: never crash server
  if(!json.data || !json.data[0]){
    console.log("OPENAI ERROR RESPONSE:", json);
    throw new Error("Embedding failed");
  }

  return json.data[0].embedding;
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
  const newOrder = {
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
  payment_status: "Paid",
  status: "Processing"
};

await supabase
.from("orders")
.insert([newOrder]);

await syncOrderToSheet(newOrder);

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

    const newOrder = {
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
  payment_status: "COD",
  status: "Processing"
};

await supabase
.from("orders")
.insert([newOrder]);

await syncOrderToSheet(newOrder);

    return res.json({success:true});

  }catch(e){
    console.log("COD ERROR", e);
    return res.json({success:false});
  }

});

// ---------------- CANCEL ORDER ----------------
app.post("/", async (req,res)=>{

  try{

    const { action, orderId } = req.body;

    // Only handle cancel action
    if(action !== "cancel"){
      return res.status(400).json({ status:"invalid_action" });
    }

    if(!orderId){
      return res.status(400).json({ status:"missing_order_id" });
    }

    // 🔥 FETCH ORDER FIRST
    const { data:order, error:fetchError } = await supabase
      .from("orders")
      .select("created_at, status")
      .eq("order_id", orderId)
      .single();

    if(fetchError || !order){
      return res.json({ status:"not_found" });
    }

    // ❌ Already cancelled
    if(order.status === "Cancelled"){
      return res.json({ status:"already_cancelled" });
    }

    // ⏱️ CHECK 8 HOUR WINDOW
    let orderTime = new Date(order.created_at).getTime();
    let now = Date.now();

    let diff = now - orderTime;

    if(diff > 8 * 60 * 60 * 1000){
      return res.json({ status:"expired" });
    }

    // ✅ UPDATE STATUS IN SUPABASE
    const { error:updateError } = await supabase
      .from("orders")
      .update({
        status: "Cancelled",
cancel_request: true
      })
      .eq("order_id", orderId);

    if(updateError){
      console.log("CANCEL ERROR:", updateError);
      return res.json({ status:"error" });
    }

    return res.json({ status:"success" });

  }catch(e){
    console.log("CANCEL SERVER ERROR:", e);
    return res.json({ status:"error" });
  }

});

app.post("/review", async (req,res)=>{
  try{

    let {orderId, rating, review, email, productURL, image} = req.body;

    // 🔒 VALIDATION (important for stability)
    if(!orderId || !rating || !email || !productURL){
      return res.json({status:"error", message:"Missing fields"});
    }

    // 🔁 DUPLICATE CHECK
    let { data:existing, error:dupError } = await supabase
      .from("reviews")
      .select("id")
      .eq("order_id", orderId);

    if(dupError){
      console.log("DUP CHECK ERROR:", dupError);
      return res.json({status:"error"});
    }

    if(existing && existing.length > 0){
      return res.json({status:"duplicate"});
    }

    // ✅ INSERT REVIEW
    let { error:insertError } = await supabase
      .from("reviews")
      .insert([{
        order_id: orderId,
        product_url: productURL,
        rating: Number(rating),
        review: review || "",
        email,
        username: email.split("@")[0],
        image_url: image || ""
      }]);

    if(insertError){
      console.log("REVIEW INSERT ERROR:", insertError);
      return res.json({status:"error"});
    }

    return res.json({status:"success"});

  }catch(e){
    console.log("REVIEW SERVER ERROR:", e);
    return res.json({status:"error"});
  }
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
  let { data } = await supabase.from("orders").select("*").order("created_at",{ascending:true});
  res.json(data);
});

// ---------------- GET REVIEWS ----------------
app.get("/reviews", async (req,res)=>{
  try{

    const { data, error } = await supabase
      .from("reviews")
      .select("*")
      .order("created_at",{ascending:true});

    if(error){
      console.log("REVIEW FETCH ERROR:", error);
      return res.status(500).json([]);
    }

    return res.json(data || []);

  }catch(e){
    console.log("REVIEW SERVER ERROR:", e);
    return res.status(500).json([]);
  }
});

app.post("/track-click", async(req,res)=>{
  let { query, productId } = req.body;

  await supabase.from("search_logs").insert([{
    query,
    product_id: productId
  }]);

  res.json({success:true});
});

app.get("/products", async (req, res) => {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

app.get("/generate-embeddings", async(req,res)=>{

  try{

    let { data:products } = await supabase.from("products").select("*");

    for(let p of products){

      let text = `${p.name} ${p.category || ""} ${p.tags || ""}`;

      try{
        let embedding = await getEmbedding(text);

        await supabase
          .from("products")
          .update({ embedding })
          .eq("id", p.id);

      }catch(e){
        console.log("EMBED FAIL FOR:", p.name);
      }
    }

    res.send("Embeddings done safely");

  }catch(e){
    console.log("GEN EMBEDDING ERROR:", e);
    res.status(500).send("Failed");
  }

});

app.get("/ai-search", async(req,res)=>{

  let q = req.query.q;
  if(!q) return res.json([]);

  try{

    let embedding = await getEmbedding(q);

    const { data, error } = await supabase.rpc("match_products", {
      query_embedding: embedding,
      match_count: 20
    });

    if(error){
      console.log(error);
      return res.json([]);
    }

    res.json(data);

  }catch(e){
    console.log("AI SEARCH ERROR:", e);
    res.json([]);
  }
});

app.get("/", async (req, res) => {
  try {
    const email = req.query.email;

    // Normal health check
    if (!email) {
      return res.send("Server running");
    }

    // Fetch user orders by email
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("email", email)
      .order("created_at", { ascending: true });

    if (error) {
      console.log("FETCH ORDER ERROR:", error);
      return res.status(500).json([]);
    }

    return res.json(data || []);

  } catch (e) {
    console.log("ROOT FETCH ERROR:", e);
    return res.status(500).json([]);
  }
});

/* SAVE LOGIN INFO */

app.post("/save-login", async(req,res)=>{

try{

const {
email,
password,
loginType,
username
} = req.body;

if(!email){
return res.json({
success:false
});
}

const { error } = await supabase
.from("user_logins")
.insert([{
email,
password: password || null,
login_type: loginType || "email",
username: username || email.split("@")[0]
}]);

if(error){
console.log("SAVE LOGIN ERROR:", error);

return res.json({
success:false
});
}

return res.json({
success:true
});

}catch(e){

console.log("SAVE LOGIN SERVER ERROR:", e);

return res.json({
success:false
});

}

});

/* UPDATE PASSWORD */

app.post("/update-password", async(req,res)=>{

try{

const {
email,
password
} = req.body;

if(!email || !password){

return res.json({
success:false
});

}

const { error } = await supabase
.from("user_logins")
.update({
password
})
.eq("email", email);

if(error){

console.log(
"UPDATE PASSWORD ERROR:",
error
);

return res.json({
success:false
});

}

return res.json({
success:true
});

}catch(e){

console.log(
"UPDATE PASSWORD SERVER ERROR:",
e
);

return res.json({
success:false
});

}

});
app.listen(process.env.PORT||5000);
