
import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";
import products from "./products.json" with { type: "json" };
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WA_TOKEN = process.env.WHATSAPP_TOKEN;

// Health Check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
  });
});

// Home
app.get("/", (req, res) => {
  res.send("Webhook server is running.");
});
app.get("/products", (req, res) => {
  const { id, search } = req.query;

  // Search by ID
  if (id) {
    const product = products.find((p) => p.id === Number(id));

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    return res.json(product);
  }

  // Search by keyword
  if (search) {
    const keyword = search.toLowerCase().trim();

    const results = products.filter((p) =>
      p.title.toLowerCase().includes(keyword) ||
      p.description.toLowerCase().includes(keyword) ||
      p.category.toLowerCase().includes(keyword)
    );

    return res.json({
      total: results.length,
      products: results,
    });
  }

  // Return all products
  return res.json(products);
});

app.post("/checkout", (req, res) => {
  const {
    fullName,
    phoneNumber,
    addressLine1,
    city,
    state,
    postalCode,
    country,
    productName,
    price,
  } = req.body;

  // Basic validation
  const requiredFields = [
    "fullName",
    "phoneNumber",
    "addressLine1",
    "city",
    "state",
    "postalCode",
    "country",
    "productName",
    "price",
  ];

  const missingFields = requiredFields.filter(
    (field) => !req.body[field]
  );

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields.",
      missingFields,
    });
  }

  // Random delivery between 1 and 7 days
  const randomDays = Math.floor(Math.random() * 7) + 1;

  const arrivalDate = new Date();
  arrivalDate.setDate(arrivalDate.getDate() + randomDays);

  res.status(200).json({
    success: true,
    message: "Order placed successfully.",
    order: {
      customer: fullName,
      productName,
      price,
    },
    estimatedArrivalDate: arrivalDate.toISOString().split("T")[0], // YYYY-MM-DD
  });
});

app.post("/places/autocomplete", async (req, res) => {
  try {
    const { input } = req.body;

    const response = await axios.post(
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        input
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        }
      }
    );

    const suggestions =
      response.data.suggestions?.map((item) => ({
        placeId: item.placePrediction.placeId,
        name: item.placePrediction.text.text
      })) || [];

    res.json(suggestions);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json(err.response?.data || {});
  }
});
app.post("/places/details", async (req, res) => {
  try {
    const { placeId } = req.body;

    if (!placeId) {
      return res.status(400).json({
        message: "placeId is required"
      });
    }

    const response = await axios.get(
  `https://places.googleapis.com/v1/places/${placeId}`,
  {
    headers: {
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,location"
    }
  }
);

    res.json({
      placeId: response.data.id,
      name: response.data.displayName.text,
      address: response.data.formattedAddress,
      latitude: response.data.location.latitude,
      longitude: response.data.location.longitude
    });

  } catch (err) {
    console.error(err.response?.data || err.message);

    res.status(500).json(err.response?.data || {});
  }
});


app.post("/route", async (req, res) => {
  try {
    const {
      pickupLatitude,
      pickupLongitude,
      dropoffLatitude,
      dropoffLongitude,
    } = req.body;

     if (
      pickupLatitude == null ||
      pickupLongitude == null ||
      dropoffLatitude == null ||
      dropoffLongitude == null
    ) {
      return res.status(400).json({
        success: false,
        message: "Pickup and dropoff coordinates are required.",
      });
    }

    // Step 1: Compute the driving route
    const routeResponse = await axios.post(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        origin: {
          location: {
            latLng: {
              latitude: Number(pickupLatitude),
              longitude: Number(pickupLongitude),
            },
          },
        },
        destination: {
          location: {
            latLng: {
              latitude: Number(dropoffLatitude),
              longitude: Number(dropoffLongitude),
            },
          },
        },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask":
            "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
        },
      }
    );

    if (
      !routeResponse.data.routes ||
      routeResponse.data.routes.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message: "No route found.",
      });
    }

    const route = routeResponse.data.routes[0];

    const distanceMeters = route.distanceMeters;
    const distanceKm = (distanceMeters / 1000).toFixed(2);

    // duration comes as "1832s"
    const durationSeconds = parseInt(route.duration.replace("s", ""), 10);

    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);

    const formattedDuration =
      hours > 0
        ? `${hours} hr ${minutes} min`
        : `${minutes} min`;

    const encodedPolyline = route.polyline.encodedPolyline;

    // Step 2: Build Static Map URL
    const mapUrl =
      `https://maps.googleapis.com/maps/api/staticmap` +
      `?size=900x600` +
      `&scale=2` +
      `&maptype=roadmap` +
      `&markers=color:green|label:P|${pickupLatitude},${pickupLongitude}` +
      `&markers=color:red|label:D|${dropoffLatitude},${dropoffLongitude}` +
      `&path=color:0x1976D2|weight:6|enc:${encodeURIComponent(
        encodedPolyline
      )}` +
      `&key=${process.env.GOOGLE_MAPS_API_KEY}`;

    return res.json({
      success: true,
      pickup: {
        latitude: Number(pickupLatitude),
        longitude: Number(pickupLongitude),
      },
      dropoff: {
        latitude: Number(dropoffLatitude),
        longitude: Number(dropoffLongitude),
      },
      distance: {
        meters: distanceMeters,
        kilometers: distanceKm,
      },
      duration: {
        seconds: durationSeconds,
        text: formattedDuration,
      },
      mapUrl,
    });
    // // Center of map
    // const centerLat =
    //   (Number(pickupLatitude) + Number(dropoffLatitude)) / 2;

    // const centerLng =
    //   (Number(pickupLongitude) + Number(dropoffLongitude)) / 2;

    // // Free OpenStreetMap Directions URL
    // const mapUrl =
    //   `https://www.openstreetmap.org/directions` +
    //   `?engine=fossgis_osrm_car` +
    //   `&route=${pickupLatitude},${pickupLongitude};${dropoffLatitude},${dropoffLongitude}` +
    //   `#map=12/${centerLat}/${centerLng}`;

      
  } catch (err) {
    console.error(err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      message: "Unable to calculate route.",
      error: err.response?.data || err.message,
    });
  }
});

const drivers = [
  {
    id: "DRV001",
    name: "Rahul Sharma",
    phone: "+919810000001",
    vehicle: "KA01AB1234",
    location: { latitude: 12.9716, longitude: 77.5946 }
  },
  {
    id: "DRV002",
    name: "Amit Verma",
    phone: "+919810000002",
    vehicle: "KA02CD5678",
    location: { latitude: 12.9854, longitude: 77.6058 }
  },
  {
    id: "DRV003",
    name: "Rakesh Kumar",
    phone: "+919810000003",
    vehicle: "KA03EF2345",
    location: { latitude: 12.9898, longitude: 77.6203 }
  },
  {
    id: "DRV004",
    name: "Suresh Patel",
    phone: "+919810000004",
    vehicle: "KA04GH9876",
    location: { latitude: 12.9634, longitude: 77.6011 }
  },
  {
    id: "DRV005",
    name: "Vijay Singh",
    phone: "+919810000005",
    vehicle: "KA05JK3456",
    location: { latitude: 12.9502, longitude: 77.6109 }
  },
  {
    id: "DRV006",
    name: "Manoj Yadav",
    phone: "+919810000006",
    vehicle: "KA06LM6789",
    location: { latitude: 12.9772, longitude: 77.6385 }
  },
  {
    id: "DRV007",
    name: "Deepak Gupta",
    phone: "+919810000007",
    vehicle: "KA07NP4567",
    location: { latitude: 12.9423, longitude: 77.5841 }
  },
  {
    id: "DRV008",
    name: "Anil Mehta",
    phone: "+919810000008",
    vehicle: "KA08QR1122",
    location: { latitude: 12.9982, longitude: 77.6412 }
  },
  {
    id: "DRV009",
    name: "Prakash Jain",
    phone: "+919810000009",
    vehicle: "KA09ST3344",
    location: { latitude: 12.9321, longitude: 77.6187 }
  },
  {
    id: "DRV010",
    name: "Sunil Nair",
    phone: "+919810000010",
    vehicle: "KA10UV5566",
    location: { latitude: 12.9618, longitude: 77.6464 }
  },
  {
    id: "DRV011",
    name: "Arjun Reddy",
    phone: "+919810000011",
    vehicle: "KA11WX7788",
    location: { latitude: 12.9745, longitude: 77.6533 }
  },
  {
    id: "DRV012",
    name: "Kiran Rao",
    phone: "+919810000012",
    vehicle: "KA12YZ8899",
    location: { latitude: 12.9457, longitude: 77.6294 }
  },
  {
    id: "DRV013",
    name: "Rohit Mishra",
    phone: "+919810000013",
    vehicle: "KA13AA1111",
    location: { latitude: 12.9841, longitude: 77.5715 }
  },
  {
    id: "DRV014",
    name: "Nitin Joshi",
    phone: "+919810000014",
    vehicle: "KA14BB2222",
    location: { latitude: 12.9683, longitude: 77.6624 }
  },
  {
    id: "DRV015",
    name: "Harish Gowda",
    phone: "+919810000015",
    vehicle: "KA15CC3333",
    location: { latitude: 12.9564, longitude: 77.5978 }
  }
];

// In-memory ride store
const rides = {};

app.post("/driverdetails", (req, res) => {
  const { customerPhone } = req.body;

  if (!customerPhone) {
    return res.status(400).json({
      success: false,
      message: "customerPhone is required"
    });
  }

  // Existing active ride?
  let ride = Object.values(rides).find(
    r =>
      r.customerPhone === customerPhone &&
      ["ASSIGNED", "STARTED"].includes(r.status)
  );

  // Create a new ride if none exists
  if (!ride) {
    const driver =
      drivers[Math.floor(Math.random() * drivers.length)];

    const rideId = `RIDE-${Date.now()}`;

    ride = {
      rideId,
      customerPhone,
      otp: crypto.randomInt(100000, 999999).toString(),
      status: "ASSIGNED",
      driver
    };

    rides[rideId] = ride;
  }

  return res.json({
    success: true,
    rideId: ride.rideId,
    otp: ride.otp,
    status: ride.status,
    driver: {
      id: ride.driver.id,
      name: ride.driver.name,
      phone: ride.driver.phone,
      vehicle: ride.driver.vehicle,
      location: ride.driver.location
    }
  });
});
app.post("/ride/verify-otp", async (req, res) => {
  try {
    let { rideId, otp, customerPhone } = req.body;

    if (!rideId || !otp || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: "rideId, otp and customerPhone are required",
      });
    }

    // Remove all non-digit characters
    customerPhone = customerPhone.toString().replace(/\D/g, "");

    // Remove country code if user already passed 91XXXXXXXXXX
    if (customerPhone.startsWith("91") && customerPhone.length === 12) {
      customerPhone = customerPhone.substring(2);
    }

    // Validate Indian mobile number
    if (customerPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: "Invalid mobile number",
      });
    }

    // Add +91 prefix
    customerPhone = `+91${customerPhone}`;

    const ride = rides[rideId];

    if (!ride) {
      return res.status(404).json({
        success: false,
        message: "Ride not found",
      });
    }

    if (ride.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: "Invalid OTP",
      });
    }

    // Save customer phone for Meta Agent Event
    ride.customerPhone = customerPhone;

    // Update ride status
    ride.status = "STARTED";

    // Trigger Meta Business Agent Event
    let metaResponse = null;

    try {
      metaResponse = await sendRideStartedEvent(ride);
    } catch (err) {
      console.error("Meta Agent Event Failed", err.response?.data || err.message);
    }

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully.",
      rideId: ride.rideId,
      rideStatus: ride.status,
      customerPhone,
      driver: ride.driver,
      metaAgentEvent: metaResponse ?? "Failed",
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
});
async function sendRideStartedEvent(ride) {
  try {
    const entityId = process.env.META_ENTITY_ID;
    console.log(ride)

    const response = await axios.post(
      `https://api.facebook.com/${entityId}/agent_event`,
      {
        to: ride.customerPhone,
        event: {
          type: "ride_started",
          description:
            "The customer OTP was verified and the ride has now started. Notify the user that their ride has begun and that they are on their way to the drop-off.",
          payload: JSON.stringify({
            rideId: ride.rideId,
            rideStatus: ride.status,
            driver: {
              name: ride.driver.name,
              phone: ride.driver.phone,
              vehicle: ride.driver.vehicle,
            },
          }),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
          "X-API-Version": "2.0.0",
        },
      }
    );

    console.log("✅ Meta Agent Event Sent");
    return response.data;
  } catch (err) {
    console.error(
      "Meta Agent Event Failed",
      err.response?.data || err.message
    );
    throw err;
  }
}
// Meta Webhook Verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log({
    mode,
    token,
    VERIFY_TOKEN,
  });

  if (mode === "subscribe" && token === WA_TOKEN) {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challenge);
  }

  console.log("❌ WEBHOOK VERIFICATION FAILED");
  return res.sendStatus(403);
});

// Meta Webhook Events
app.post("/webhook", (req, res) => {
  console.log("📩 Webhook Received");

  console.dir(req.body, { depth: null });

  // Acknowledge receipt immediately
  res.sendStatus(200);
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Health : http://localhost:${PORT}/health`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});