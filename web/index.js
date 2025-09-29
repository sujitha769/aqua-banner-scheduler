// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";
import multer from "multer"; // handle file uploads
import fs from "fs";

import fetch, { Blob, File } from "node-fetch";
import FormData from "form-data";
import { MongoClient, ObjectId } from "mongodb"; // MongoDB

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000", 10);

// ✅ MongoDB connection
const mongoClient = new MongoClient(
  "mongodb+srv://suji:suji123@cluster0.upriz9p.mongodb.net/aqua?retryWrites=true&w=majority&appName=Cluster0"
);
await mongoClient.connect();
const db = mongoClient.db("aqua");
const Banners = db.collection("banners");

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// --- Shopify auth & webhooks ---
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// Middleware
app.use("/api", shopify.validateAuthenticatedSession());
app.use(express.json());

// 🚀 Banner Upload API
const upload = multer({ dest: "uploads/" });

app.post("/api/upload", upload.single("banner"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: "No file uploaded (field 'banner')" });

  const tempPath = req.file.path;
  const filename = req.file.originalname || "banner.png";
  const mimeType = req.file.mimetype || "image/png";

  // ⬅️ metadata fields
  const { title, alt, startDate, endDate } = req.body;

  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    // 1) Get staged upload target
    const stagedMutation = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `;

    const fileSize = fs.statSync(tempPath).size.toString();

    const stagedResp = await client.request(stagedMutation, {
      variables: {
        input: [
          {
            resource: "FILE",
            filename,
            mimeType,
            fileSize,
            httpMethod: "POST",
          },
        ],
      },
    });

    const stagedCreate = stagedResp.data.stagedUploadsCreate;
    if (stagedCreate.userErrors?.length) {
      return res.status(400).json({ error: stagedCreate.userErrors });
    }

    const target = stagedCreate.stagedTargets?.[0];
    if (!target?.url) throw new Error("No staged upload target from Shopify");

    // 2) Upload binary to Shopify
    const form = new FormData();
    target.parameters.forEach((p) => form.append(p.name, p.value));
    form.append("file", fs.createReadStream(tempPath), {
      filename,
      contentType: mimeType,
    });

    const uploadRes = await fetch(target.url, { method: "POST", body: form });
    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

    // 3) Create File in Shopify
    const fileCreateMutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            preview { image { url } }
            alt
          }
          userErrors { field message }
        }
      }
    `;

    const fileCreateResp = await client.request(fileCreateMutation, {
      variables: {
        files: [
          {
            alt: alt || filename,
            contentType: "IMAGE",
            originalSource: target.resourceUrl,
          },
        ],
      },
    });

    const fileCreateResult = fileCreateResp.data.fileCreate;
    if (fileCreateResult.userErrors?.length) {
      return res.status(400).json({ error: fileCreateResult.userErrors });
    }

    const createdFile = fileCreateResult.files?.[0];
    let previewUrl = createdFile?.preview?.image?.url || target.resourceUrl;

    // 4) Save into MongoDB
    await Banners.insertOne({
      title,
      alt,
      startDate,
      endDate,
      url: previewUrl,
      createdAt: new Date(),
    });

    fs.unlinkSync(tempPath); // cleanup
    res.status(200).json({ success: true, url: previewUrl });
  } catch (err) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    console.error("Upload error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// 🚀 Fetch Banners + Status + Counts (Admin API)
app.get("/api/banners", async (_req, res) => {
  try {
    const banners = await Banners.find().sort({ createdAt: -1 }).toArray();

    const today = new Date();
    const withStatus = banners.map((b) => {
      const start = b.startDate ? new Date(b.startDate) : null;
      const end = b.endDate ? new Date(b.endDate) : null;

      let status = "Scheduled";
      if (start && start <= today && (!end || end >= today)) {
        status = "Active";
      } else if (end && end < today) {
        status = "Expired";
      }

      return { ...b, status };
    });

    const counts = {
      active: withStatus.filter((b) => b.status === "Active").length,
      scheduled: withStatus.filter((b) => b.status === "Scheduled").length,
      expired: withStatus.filter((b) => b.status === "Expired").length,
    };

    res.json({ banners: withStatus, counts });
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch banners" });
  }
});

// 🚀 Delete Banner
app.delete("/api/banners/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await Banners.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Banner not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete banner" });
  }
});

// 🚀 Edit Banner
app.put("/api/banners/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, alt, startDate, endDate } = req.body;

    const result = await Banners.updateOne(
      { _id: new ObjectId(id) },
      { $set: { title, alt, startDate, endDate } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Banner not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ error: "Failed to update banner" });
  }
});

// Example routes
app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({
    session: res.locals.shopify.session,
  });
  const countData = await client.request(`{ productsCount { count } }`);
  res.status(200).send({ count: countData.data.productsCount.count });
});

app.post("/api/products", async (_req, res) => {
  try {
    await productCreator(res.locals.shopify.session);
    res.status(200).send({ success: true });
  } catch (e) {
    res.status(500).send({ success: false, error: e.message });
  }
});

// ✅ OLD PROXY ROUTE FOR HTML (Keep for backwards compatibility)
app.get("/apps/banner", async (req, res) => {
  try {
    const today = new Date();
    const banners = await Banners.find().toArray();

    const active = banners.filter((b) => {
      const start = b.startDate ? new Date(b.startDate) : null;
      const end = b.endDate ? new Date(b.endDate) : null;
      return start && start <= today && (!end || end >= today);
    });

    if (!active.length) {
      return res.send("<div style='display:none'></div>");
    }

    const html = active
      .map(
        (b) => `
        <div class="shopify-dynamic-banner">
          <img src="${b.url}" alt="${b.alt || ""}" style="max-width:100%; height:auto;" />
        </div>
      `
      )
      .join("");

    res.send(html);
  } catch (err) {
    console.error("Proxy banner error:", err);
    res.status(500).send("Error loading banners");
  }
});

// ✅ NEW API ROUTE FOR THEME EXTENSION (JSON Response)
app.get("/apps/banner-api/active", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset to start of day for accurate comparison

    const banners = await Banners.find().toArray();

    // Filter active banners
    const active = banners.filter((b) => {
      const start = b.startDate ? new Date(b.startDate) : null;
      const end = b.endDate ? new Date(b.endDate) : null;
      
      // Reset time for dates to compare only date part
      if (start) start.setHours(0, 0, 0, 0);
      if (end) end.setHours(23, 59, 59, 999);
      
      return start && start <= today && (!end || end >= today);
    });

    // Return JSON response
    res.status(200).json({
      success: true,
      banners: active.map(b => ({
        id: b._id,
        title: b.title,
        alt: b.alt,
        url: b.url,
        startDate: b.startDate,
        endDate: b.endDate
      })),
      count: active.length
    });
  } catch (err) {
    console.error("Active banners API error:", err);
    res.status(500).json({ 
      success: false, 
      error: "Error loading banners",
      banners: [],
      count: 0
    });
  }
});

// Serve frontend
app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));
app.get("/:path(.*)", shopify.ensureInstalledOnShop(), (_req, res) => {
  res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

app.listen(PORT, () =>
  console.log(`🚀 Server running at http://localhost:${PORT}`)
);