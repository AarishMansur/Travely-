const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    placeKey: { type: String, required: true, index: true },
    placeName: { type: String, required: true, trim: true, maxlength: 200 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    safetyRating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    timeOfDay: {
      type: String,
      enum: ["morning", "afternoon", "evening", "night"],
      default: "afternoon",
    },
    travelledAlone: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Review", reviewSchema);
