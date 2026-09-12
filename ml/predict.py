#!/usr/bin/env python3
"""
Loads model.joblib (produced by train.py) and predicts a yield estimate for
one farm's current soil + climate snapshot. Called by server.js for every
dashboard/admin load. If no model has been trained yet, or scikit-learn
isn't installed, it prints {"error": ...} and server.js falls back to the
rule-based heuristic automatically -- nothing breaks either way.

Usage:
    python predict.py '{"cropType": "Rice (Palay)", "nitrogen": 40, ...}'
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "model.joblib")
METRICS_PATH = os.path.join(HERE, "metrics.json")

NUMERIC_FEATURES = ["nitrogen", "phosphorus", "potassium", "ph", "moisturePercent", "avgTemp", "weeklyRainMm"]


def main():
    if not os.path.exists(MODEL_PATH):
        print(json.dumps({"error": "model_not_trained"}))
        return

    try:
        import joblib
        import pandas as pd
    except ImportError as e:
        print(json.dumps({"error": f"missing_package:{e.name}"}))
        return

    if len(sys.argv) < 2:
        print(json.dumps({"error": "no_features_provided"}))
        return

    try:
        features = json.loads(sys.argv[1])
    except json.JSONDecodeError:
        print(json.dumps({"error": "invalid_features_json"}))
        return

    bundle = joblib.load(MODEL_PATH)
    model = bundle["model"]
    feature_columns = bundle["feature_columns"]

    row = {col: 0 for col in feature_columns}
    for key in NUMERIC_FEATURES:
        if key in feature_columns:
            row[key] = features.get(key, 0) or 0
    crop_col = f"crop_{features.get('cropType')}"
    if crop_col in row:
        row[crop_col] = 1

    X = pd.DataFrame([row], columns=feature_columns)
    pred = float(model.predict(X)[0])

    training_samples = None
    if os.path.exists(METRICS_PATH):
        with open(METRICS_PATH) as f:
            training_samples = json.load(f).get("trainingSamples")

    print(json.dumps({"estimatedTonPerHa": pred, "trainingSamples": training_samples}))


if __name__ == "__main__":
    main()
