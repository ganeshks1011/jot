// Simple test to validate behavior without relying on built files

const fs = require("fs");

// Let's manually parse and run the functions to understand their behavior
const sitePersonasCode = fs.readFileSync("./src/lib/sitePersonas.ts", "utf-8");
console.log("Site personas code parsed");

// Parse to extract just the relevant function
const lines = sitePersonasCode.split("\n");
let inFunction = false;
const functionLines = [];
let started = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (line.includes("export function matchesSite")) {
    inFunction = true;
    started = true;
    functionLines.push(line);
  } else if (inFunction) {
    // This is a bit crude but works for the specific case
    functionLines.push(line);
    if (line.includes("}")) {
      break;
    }
  }
}

console.log("matchesSite function:");
console.log(functionLines.join("\n"));

// Extract function to test directly
const matchesSiteCode = `
export function matchesSite(pattern, hostname) {
  const p = pattern.trim().toLowerCase().replace(/^https?:\\/\\//, "");
  const host = hostname.trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith("*.")) {
    const rest = p.slice(2);
    return host === rest || host.endsWith(\`.\${rest}\`);
  }
  return host === p || host.endsWith(\`.\${p}\`);
}
`;

let matchesSite;

eval(matchesSiteCode);

console.log("\nTesting matchesSite:");
console.log("matchesSite('*.example.com', 'mail.example.com'):", matchesSite("*.example.com", "mail.example.com"));
console.log("matchesSite('*.example.com', 'example.com'):", matchesSite("*.example.com", "example.com"));

console.log("\nCase sensitivity test:");
console.log("matchesSite('EXAMPLE.COM', 'example.com'):", matchesSite("EXAMPLE.COM", "example.com"));
