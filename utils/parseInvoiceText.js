// utils/parseInvoiceText.js
const parseInvoiceText = (text) => {
    const lines = text.split('\n');
    const extractedItems = [];
  
    lines.forEach(line => {
      const match = line.match(/^(\d{6})\s+(.*?)\s+(\d+)?\s+([0-9]+[.,][0-9]{2})/);
  
      if (match) {
        const code = match[1];          // e.g., 246612
        const name = match[2].trim();    // e.g., Nestle Pure Life Multipack
        const quantity = match[3] || '1';// e.g., 5 (if available)
        const price = match[4];          // e.g., 3.49
  
        extractedItems.push({
          name,
          quantity,
          price,
        });
      }
    });
  
    return extractedItems;
  };
  
  module.exports = parseInvoiceText;
  