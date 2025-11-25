// --- PLAN & PRICING DATA MODEL (Centralized Source of Truth) ---
// This data model drives both the public pricing page and the admin client management.

const PLANS = [
    { name: 'Growth Starter', basePrice: 1000, credits: '10,000' },
    { name: 'Business Pro', basePrice: 2000, credits: '25,000' },
    { name: 'Enterprise Max', basePrice: 5000, credits: 'Unlimited' },
];

const DURATIONS = [
    { months: 1, label: "1 Month", discount: 0 },
    { months: 3, label: "3 Months", discount: 0.20 },
    { months: 6, label: "6 Months", discount: 0.30 },
    { months: 12, label: "1 Year", discount: 0.40 },
];

// Function to calculate the final price including GST
function calculatePrice(basePrice, months, discount) {
    const monthlyTotal = basePrice * months;
    const discountedTotal = monthlyTotal * (1 - discount);
    // Apply 18% GST (1.18 multiplier) and round to the nearest whole rupee
    return Math.round(discountedTotal * 1.18);
}