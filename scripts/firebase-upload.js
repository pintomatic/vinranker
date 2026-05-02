const path = require("path");
const { Storage } = require("@google-cloud/storage");

const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || "studio-1718008502-e95e8.appspot.com";
const DESTINATION = process.env.FIREBASE_STORAGE_PATH || "wine/wine-data.json";
const SOURCE = process.env.WINE_DATA_FILE || path.join(__dirname, "..", "data", "wine-data.json");

(async () => {
  const storage = new Storage();
  await storage.bucket(BUCKET).upload(SOURCE, {
    destination: DESTINATION,
    metadata: {
      cacheControl: "public, max-age=3600",
      contentType: "application/json",
    },
  });
  console.log(`uploaded ${SOURCE} to gs://${BUCKET}/${DESTINATION}`);
})();
