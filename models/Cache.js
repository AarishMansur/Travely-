const mongoose = require("mongoose");

const cacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  engine: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now },
});

cacheSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model("Cache", cacheSchema);
