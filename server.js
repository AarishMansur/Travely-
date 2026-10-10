require("dotenv").config();

const path = require("path");
const express = require("express");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/saferoute";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.locals.year = new Date().getFullYear();
  next();
});

app.use("/", require("./routes/index"));

app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page not found",
    message: "That page does not exist. Head back to the home page and search again.",
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).render("error", {
    title: "Something went wrong",
    message: "Please go back and try again. If it keeps happening, the server log will show why.",
  });
});

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected:", MONGODB_URI);
    app.listen(PORT, () => {
      console.log(`SafeRoute running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("\nCould not connect to MongoDB.");
    console.error("Start it locally, for example:");
    console.error("  docker run -d --name saferoute-mongo -p 27017:27017 mongo");
    console.error("or set MONGODB_URI in .env to a MongoDB Atlas URL.");
    console.error("Error:", err.message, "\n");
    process.exit(1);
  });
