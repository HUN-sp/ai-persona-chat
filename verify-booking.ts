import { config } from "dotenv";
import { join } from "path";

// Load env
config({ path: join(process.cwd(), ".env.local") });

import { handleBookingContinue } from "./lib/booking";
import { getAvailableSlots } from "./lib/calendar";

async function runTests() {
  console.log("=== RUNNING BOOKING UNIT TESTS ===");

  const slots = await getAvailableSlots();
  console.log(`Total slots fetched: ${slots.length}`);

  // Test 1: Date parsing of "Thursday 18Jun"
  console.log("\nTest 1: parseDateFromText('Thursday 18Jun')");
  const result1 = await handleBookingContinue({
    lastMsg: "Thursday 18Jun",
    bookingStep: "day_shown",
    allSlots: slots,
    pendingSlots: slots,
    selectedSlot: null,
    slotPage: 0,
  });
  console.log("Result type:", result1.type);
  if (result1.type === "response") {
    console.log("Response reply:", result1.data.reply);
    console.log("Booking Step:", result1.data.bookingStep);
    console.log("Pending slots length:", result1.data.pendingSlots?.length);
  } else {
    console.log("Failed to match!");
  }

  // Test 2: Negation vs correction detection ("No Friday 19 Jun")
  console.log("\nTest 2: handleDayShown with 'No Friday 19 Jun'");
  const result2 = await handleBookingContinue({
    lastMsg: "No Friday 19 Jun",
    bookingStep: "day_shown",
    allSlots: slots,
    pendingSlots: slots,
    selectedSlot: null,
    slotPage: 0,
  });
  console.log("Result type:", result2.type);
  if (result2.type === "response") {
    console.log("Response reply:", result2.data.reply);
    console.log("Booking Step:", result2.data.bookingStep);
    console.log("Pending slots length:", result2.data.pendingSlots?.length);
  } else {
    console.log("Failed to match!");
  }

  // Test 3: Day switching on slots screen
  console.log("\nTest 3: handleSlotsShown switching to 'Thursday 18Jun' from Friday slots");
  // Find some Friday slots
  const uniqueDays = slots.reduce((acc: any[], s) => {
    const dStr = new Date(s.start).toDateString();
    if (!acc.some(a => a.dateStr === dStr)) {
      acc.push({ dateStr: dStr, slots: [s] });
    } else {
      acc.find(a => a.dateStr === dStr).slots.push(s);
    }
    return acc;
  }, []);

  const friday = uniqueDays.find(d => d.dateStr.includes("Fri"));
  const thursday = uniqueDays.find(d => d.dateStr.includes("Thu") && d.dateStr.includes("18"));

  if (friday && thursday) {
    console.log(`Current pending slots: Friday slots (${friday.slots.length})`);
    const result3 = await handleBookingContinue({
      lastMsg: "Thursday 18Jun",
      bookingStep: "slots_shown",
      allSlots: slots,
      pendingSlots: friday.slots,
      selectedSlot: null,
      slotPage: 0,
    });
    console.log("Result type:", result3.type);
    if (result3.type === "response") {
      console.log("Response reply:", result3.data.reply);
      console.log("Booking Step:", result3.data.bookingStep);
      console.log("Pending slots length:", result3.data.pendingSlots?.length);
    } else {
      console.log("Failed to switch!");
    }
  } else {
    console.log("Friday or Thursday 18th slots not found for testing!");
  }
}

runTests().catch(console.error);
