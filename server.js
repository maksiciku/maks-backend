// Import necessary modules
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const exec = require('child_process').execSync; // Add this to execute system commands
const { execSync } = require('child_process');
const SECRET_KEY = process.env.SECRET_KEY || 'dev_secret_change_me';
const scanRoutes = require('./routes/scanRoutes'); // Import scan routes
const posRoutes = require('./routes/posRoutes');
const { v4: uuidv4 } = require('uuid'); // Add this at the top of your file
const parseInvoiceText = require('./utils/parseInvoiceText');
const { authenticateToken, checkRoles } = require('./middleware/authMiddleware');
const supplierRoutes = require('./routes/supplierRoutes');
const util = require('util');
const { getIngredientFacts, isInGrams, getEstimatedGrams } = require('./utils/novaKnowledge');
const bookingRoutes = require('./routes/bookingRoutes');
const drinksRoutes = require('./routes/drinksRoutes');
const compat = require('./dbSqliteCompat');
const db = compat;          // keeps db.run / db.get / db.all working
const { pool } = compat;    // keeps pool.query(...) working
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const qRun = (sql, params = []) => db.runAsync(sql, params);
const qGet = (sql, params = []) => db.getAsync(sql, params);
const qAll = (sql, params = []) => db.allAsync(sql, params);

// Initialize Express app
const app = express();
const PORT = 5000;
const allowed = [
  'http://localhost:3000',
  'https://your-frontend.vercel.app',    // update after frontend deploy
];

// Middleware to parse JSON requests
app.use(express.json());
app.use(cors());

app.use('/invoices', scanRoutes); // ✅ Now `/scan/scan-ingredient-image` works
app.use('/pos-orders', posRoutes);
app.use('/suppliers', supplierRoutes);
app.use('/bookings', bookingRoutes);
app.use('/drinks', drinksRoutes);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // mobile apps, curl, etc.
    return cb(null, allowed.includes(origin));
  },
  credentials: true
}));

// Configure Multer to store files in "uploads/"
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`);
    }
});
const upload = multer({ storage });

function deductDrinkStock(drinkName, quantity, callback) {
  db.get(
    `SELECT quantity FROM stock WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
    [drinkName],
    (err, row) => {
      if (err || !row) {
        return callback(err || new Error(`Drink "${drinkName}" not found in stock.`));
      }
      const newQty = row.quantity - quantity;
      db.run(
        `UPDATE stock SET quantity = ? WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
        [newQty, drinkName],
        (err2) => {
          if (err2) return callback(err2);
          console.log(`🧊 Stock updated for drink: ${drinkName}, -${quantity}`);
          callback(null);
        }
      );
    }
  );
}

// Connect to SQLite database
const dbPath = path.resolve(__dirname, 'database.db');
console.log(`🔍 Using SQLite DB at: ${dbPath}`);

// Initialize the Meals table
const initializeDatabase = () => {
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS meals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ingredients TEXT NOT NULL,
        allergens TEXT,
        calories REAL,
        price REAL, -- ✅ Now included
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER
    )`;
    db.run(createTableQuery, (err) => {
        if (err) {
            console.error('Error creating table:', err.message);
        } else {
            console.log('Meals table is ready.');
        }
    });
};
initializeDatabase();

const initializeMealIngredientsTable = () => {
  const query = `
    CREATE TABLE IF NOT EXISTS meal_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id INTEGER NOT NULL,
      ingredient TEXT NOT NULL,
      quantity REAL NOT NULL,
      FOREIGN KEY (meal_id) REFERENCES meals(id)
    )
  `;

  db.run(query, (err) => {
    if (err) {
      console.error('❌ Failed to create meal_ingredients table:', err.message);
    } else {
      console.log('✅ meal_ingredients table is ready.');
    }
  });
};

initializeMealIngredientsTable(); // 👈 Call it after the meals table init

// Initialize the Users table
const initializeUsersTable = () => {
    const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    )`;
    db.run(createTableQuery, (err) => {
        if (err) {
            console.error('Error creating users table:', err.message);
        } else {
            console.log('Users table is ready.');
        }
    });
};
initializeUsersTable();

const initializeOrdersTable = () => {
  const query = `
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      total_price REAL NOT NULL,
      table_number TEXT DEFAULT 'Takeaway',
      order_status TEXT DEFAULT 'Pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      price REAL DEFAULT 0,
      paid INTEGER DEFAULT 0,
      batch_id TEXT,
      category TEXT DEFAULT 'meals'
    )
  `;

  db.run(query, (err) => {
    if (err) console.error("❌ Error creating orders table:", err.message);
    else console.log("✅ Orders table is ready.");
  });
};
initializeOrdersTable();
  
const initializeTablesTable = () => {
  const query = `
    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'free',
      active_order_id INTEGER,
      x REAL DEFAULT 0,
      y REAL DEFAULT 0
    )
  `;
  db.run(query, (err) => {
    if (err) console.error('Error creating tables table:', err.message);
    else console.log('✅ Tables table is ready.');
  });
};

async function seedTables() {
  const sql = `INSERT INTO tables (name) VALUES (?) ON CONFLICT(name) DO NOTHING`;
  for (let i = 1; i <= 12; i++) {
    try { await qRun(sql, [`Table ${i}`]); } catch (e) {}
  }
}

initializeTablesTable();
seedTables();

  const initializeChecklistTables = () => {
    const checklistTable = `
      CREATE TABLE IF NOT EXISTS checklists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER
      );
    `;
  
    const checklistItemsTable = `
      CREATE TABLE IF NOT EXISTS checklist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checklist_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        completed_by INTEGER,
        completed_at TEXT,
        FOREIGN KEY (checklist_id) REFERENCES checklists(id)
      );
    `;
  
    db.run(checklistTable, (err) => {
      if (err) console.error("❌ Error creating checklists table:", err.message);
      else console.log("✅ Checklists table ready.");
    });
  
    db.run(checklistItemsTable, (err) => {
      if (err) console.error("❌ Error creating checklist_items table:", err.message);
      else console.log("✅ Checklist items table ready.");
    });
  };
  
  initializeChecklistTables();

  // Add this to your initialize section
const initializeAppliancesTable = () => {
    const query = `
      CREATE TABLE IF NOT EXISTS appliances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        storage_number TEXT,
        supplier TEXT,
        notes TEXT,
        created_by INTEGER
      )
    `;
    db.run(query, (err) => {
      if (err) {
        console.error('❌ Error creating appliances table:', err.message);
      } else {
        console.log('✅ Appliances table ready.');
      }
    });
  };
  
  initializeAppliancesTable(); // ✅ Call this early on
  
  const initializeApplianceChecksTable = () => {
    const query = `
      CREATE TABLE IF NOT EXISTS appliance_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appliance_id INTEGER NOT NULL,
        temperature TEXT NOT NULL,
        shift TEXT NOT NULL,
        time_recorded TEXT NOT NULL
      )
    `;
    db.run(query, (err) => {
      if (err) {
        console.error('❌ Error creating appliance_checks table:', err.message);
      } else {
        console.log('✅ Appliance Checks table ready.');
      }
    });
  };
  
  initializeApplianceChecksTable(); // ✅ call this
  
  // --- core tables you reference later but never created ---
db.run(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    website TEXT,
    phone TEXT,
    contact_name TEXT,
    delivery_days TEXT
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS stock_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient TEXT NOT NULL UNIQUE,
    quantity REAL NOT NULL,
    alert_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS ordering_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier TEXT NOT NULL,
    ingredient TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL DEFAULT 0,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS prepped_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    quantity REAL DEFAULT 0,
    unit TEXT DEFAULT 'kg',
    ingredients TEXT DEFAULT '[]',
    hold_temperature TEXT,
    shelf_life_hours INTEGER DEFAULT 0,
    expiry_date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS meal_prepped_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_name TEXT NOT NULL,
    prepped_item_name TEXT NOT NULL,
    amount_per_meal REAL NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS menus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    json_data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS table_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    seats INTEGER DEFAULT 2,
    shape TEXT DEFAULT 'round',
    x REAL DEFAULT 0,
    y REAL DEFAULT 0,
    status TEXT DEFAULT 'free',
    zone TEXT DEFAULT 'Main'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    item_name TEXT,
    reason TEXT,
    reported_by TEXT,
    quantity REAL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

  const initializeDrinkOrdersTable = () => {
    const query = `
      CREATE TABLE IF NOT EXISTS drink_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drink_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        total_price REAL NOT NULL,
        table_number TEXT,
        order_status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        price REAL DEFAULT 0,
        paid INTEGER DEFAULT 0,
        batch_id TEXT
      )
    `;
    db.run(query, (err) => {
      if (err) {
        console.error("❌ Failed to create drink_orders table:", err.message);
      } else {
        console.log("✅ drink_orders table ready.");
      }
    });
  };
  initializeDrinkOrdersTable();
  
  const initializeRestockOrdersTable = () => {
    const query = `
      CREATE TABLE IF NOT EXISTS restock_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT DEFAULT 'drinks',
        ordered_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `;
    db.run(query, (err) => {
      if (err) {
        console.error("❌ Failed to create restock_orders table:", err.message);
      } else {
        console.log("✅ restock_orders table ready.");
      }
    });
  };
  initializeRestockOrdersTable();
  
  function createOrderBatchesTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS order_batches (
      id TEXT PRIMARY KEY,
      table_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivery_status TEXT,
      delivery_code TEXT
    )
  `, (err) => {
    if (err) console.error('❌ Failed to create order_batches table:', err.message);
    else console.log('✅ Correct order_batches table is ready.');
  });
}

db.all(`PRAGMA table_info(order_batches)`, [], (err, columns) => {
  if (err) {
    console.error('❌ Failed to inspect order_batches table:', err.message);
    return createOrderBatchesTable();
  }
  const hasTextId = columns?.some(col => col.name === 'id' && col.type?.toUpperCase() === 'TEXT');
  const hasIntegerId = columns?.some(col => col.name === 'id' && col.type?.toUpperCase() === 'INTEGER');

  if (hasIntegerId) {
    console.warn('⚠️ order_batches.id is INTEGER – dropping and recreating table...');
    db.run(`DROP TABLE IF EXISTS order_batches`, (err2) => {
      if (err2) console.error('❌ Failed to drop order_batches:', err2.message);
      else console.log('🗑️ Dropped incorrect order_batches table');
      createOrderBatchesTable();
    });
  } else if (hasTextId) {
    console.log('✅ order_batches.id is already TEXT – all good.');
    // ensure delivery columns exist
    ensureColumn('order_batches', 'delivery_status', 'TEXT');
    ensureColumn('order_batches', 'delivery_code', 'TEXT');
  } else {
    console.log('ℹ️ order_batches table does not exist yet – will be created.');
    createOrderBatchesTable();
  }
});
  
// Ensure allergens and calories columns exist in stock table
db.run(`ALTER TABLE stock ADD COLUMN allergens TEXT DEFAULT 'None'`, () => {});
db.run(`ALTER TABLE stock ADD COLUMN calories_per_100g REAL DEFAULT 0`, () => {});

// Ensure expiry_date and waste_flag columns exist
db.run(`ALTER TABLE stock ADD COLUMN expiry_date TEXT`, () => {});
db.run(`ALTER TABLE stock ADD COLUMN waste_flag INTEGER DEFAULT 0`, () => {});

db.allAsync = util.promisify(db.all).bind(db);
db.getAsync = util.promisify(db.get).bind(db);
db.runAsync = function(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

db.run(`
  CREATE TABLE IF NOT EXISTS supplier_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient TEXT NOT NULL,
    supplier_name TEXT NOT NULL,
    price REAL NOT NULL,
    date_added TEXT DEFAULT (datetime('now'))
  )
`, (err) => {
  if (err) {
    console.error("❌ Error creating supplier_prices table:", err);
  } else {
    console.log("✅ supplier_prices table ready.");
  }
});

// 🚨 TEMP: Drop existing order_batches if schema is incorrect
pool.query(`PRAGMA table_info(order_batches)`, (err, columns) => {
  if (err) {
    console.error('❌ Failed to inspect order_batches table:', err.message);
    return;
  }

  const hasTextId = columns?.some(col => col.name === 'id' && col.type === 'TEXT');
  const hasIntegerId = columns?.some(col => col.name === 'id' && col.type === 'INTEGER');

  if (hasIntegerId) {
    console.warn('⚠️ order_batches.id is INTEGER – dropping and recreating table...');
    db.run(`DROP TABLE IF EXISTS order_batches`, (err) => {
      if (err) console.error('❌ Failed to drop order_batches:', err.message);
      else console.log('🗑️ Dropped incorrect order_batches table');
      createOrderBatchesTable();
    });
  } else if (hasTextId) {
    console.log('✅ order_batches.id is already TEXT – all good.');
  } else {
    console.log('ℹ️ order_batches table does not exist yet – will be created.');
    createOrderBatchesTable();
  }
});

db.run('PRAGMA foreign_keys = ON;', (err) => {
  if (err) console.error('❌ Failed to enable foreign keys:', err.message);
  else console.log('✅ Foreign keys are enabled.');
});

// --- tiny migration helper ---
function ensureColumn(table, column, type) {
  db.all(`PRAGMA table_info(${table})`, [], (err, cols) => {
    if (err) return console.error(`❌ PRAGMA failed for ${table}`, err.message);
    const exists = cols?.some(c => c.name === column);
    if (!exists) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (alterErr) => {
        if (alterErr && !String(alterErr.message).includes('duplicate column')) {
          console.error(`❌ Failed to add ${column} to ${table}:`, alterErr.message);
        } else {
          console.log(`✅ Ensured ${table}.${column} (${type})`);
        }
      });
    }
  });
}

// Ensure orders can store these fields
ensureColumn('orders', 'options', 'TEXT');
ensureColumn('orders', 'note', 'TEXT');
ensureColumn('orders', 'special_requests', 'TEXT');

// --- categories table (main: meals/drinks/desserts; subcategory in name) ---
db.run(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('meals','drinks','desserts')),
    icon TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  )
`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_type_name ON categories(type, name)`);

// --- meals needs subcategory + fields you already use elsewhere ---
ensureColumn('meals', 'category', 'TEXT');         // subcategory for meals
ensureColumn('meals', 'supplier_id', 'INTEGER');   // you insert this in /meals POST
ensureColumn('meals', 'paused', 'INTEGER DEFAULT 0'); // you query meals.paused later

// --- stock is used for drinks/desserts; ensure subcategory + unit/portions_left ---
ensureColumn('stock', 'category', 'TEXT');         // subcategory for drinks/desserts
ensureColumn('stock', 'unit', 'TEXT');             // referred in /stock/available-for-delivery
ensureColumn('stock', 'portions_left', 'REAL DEFAULT 0'); // used in /stock/order-list
ensureColumn('stock', 'type', 'TEXT DEFAULT "ingredient"');
ensureColumn('stock', 'supplier_id', 'INTEGER');

// --- orders already handled earlier: options/note/special_requests ---
// ensureColumn('orders', 'options', 'TEXT');
// ensureColumn('orders', 'note', 'TEXT');
// ensureColumn('orders', 'special_requests', 'TEXT');

// --- order_batches needs delivery fields (you UPDATE these later) ---
ensureColumn('order_batches', 'delivery_status', 'TEXT');
ensureColumn('order_batches', 'delivery_code', 'TEXT');

// --- unify pause status table (you currently use both kitchen_settings & kitchen_status) ---
db.run(`
  CREATE TABLE IF NOT EXISTS kitchen_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    is_paused INTEGER DEFAULT 0
  )
`);
db.run(`INSERT INTO kitchen_settings (id, is_paused) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`);

// Make sure the table exists (lightweight)
db.run(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    icon TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  )
`);

// Ensure new columns exist on older DBs
ensureColumn('categories', 'icon', 'TEXT DEFAULT ""');
ensureColumn('categories', 'sort_order', 'INTEGER DEFAULT 0');
ensureColumn('categories', 'active', 'INTEGER DEFAULT 1');
ensureColumn('categories', 'type', 'TEXT'); // in case very old table lacked it

// appliance checks needs staff_name
ensureColumn('appliance_checks', 'staff_name', 'TEXT');

// restock_orders consistency
ensureColumn('restock_orders', 'type', 'TEXT DEFAULT "drink"');
ensureColumn('restock_orders', 'created_at', "DATETIME DEFAULT CURRENT_TIMESTAMP");

// orders safety (if you plan to keep it)
ensureColumn('orders', 'price_per_unit', 'REAL');

ensureColumn('tables', 'x', 'REAL DEFAULT 0');
ensureColumn('tables', 'y', 'REAL DEFAULT 0');

// Normalize singular -> plural in existing rows
db.run(`UPDATE categories SET type = 'meals'   WHERE LOWER(TRIM(type)) IN ('meal','meals')`);
db.run(`UPDATE categories SET type = 'drinks'  WHERE LOWER(TRIM(type)) IN ('drink','drinks')`);
db.run(`UPDATE categories SET type = 'desserts'WHERE LOWER(TRIM(type)) IN ('dessert','desserts')`);

// Unique per (type, name)
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_type_name ON categories(type, name)`);

// Register route
app.post('/register', (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
        return res.status(400).send('All fields are required.');
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    const query = `
        INSERT INTO users (username, password, role)
        VALUES (?, ?, ?)
    `;
    db.run(query, [username, hashedPassword, role], function (err) {
        if (err) {
            console.error('Error registering user:', err.message);
            return res.status(500).send('Error registering user.');
        }
        res.status(201).send('User registered successfully!');
    });
});

// Login route
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('Username and password are required.');
    }

    const query = `SELECT * FROM users WHERE username = ?`;
    db.get(query, [username], (err, user) => {
        if (err || !user) {
            return res.status(401).send('Invalid username or password.');
        }

        const isPasswordValid = bcrypt.compareSync(password, user.password);
        if (!isPasswordValid) {
            return res.status(401).send('Invalid username or password.');
        }

        const token = jwt.sign({ id: user.id, role: user.role }, SECRET_KEY, { expiresIn: '1h' });
        res.status(200).send({ token, role: user.role });
    });
});

// Add meal route
app.post('/meals', authenticateToken, checkRoles(['admin', 'staff']), async (req, res) => {
  const { name, ingredients, price, category, supplierId } = req.body;
  const userId = req.user.id;

  console.log("🧪 Ingredients array received:", ingredients);

  if (!name || !Array.isArray(ingredients) || ingredients.length === 0 || price === undefined) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  let detectedAllergens = new Set();
  let totalCalories = 0;
  let enrichedIngredients = [];

  const knownAllergens = {
    "egg": "Eggs",
    "tuna": "Fish",
    "cheese": "Milk",
    "bread": "Gluten"
  };

  const fallbackCalories = {
    "egg": 155,
    "tuna": 132,
    "cheese": 402,
    "bread": 250
  };

  // 🔍 Enrich ingredients with allergens & calories
  for (const ingredient of ingredients) {
    const ingredientName = ingredient.name?.trim().toLowerCase();
    const ingredientAmount = ingredient.amount ? parseFloat(ingredient.amount) : 100;

    if (!ingredientName) continue;

    const ingredientData = await new Promise((resolve, reject) => {
      db.get(
        `SELECT allergens, calories_per_100g FROM stock WHERE LOWER(ingredient) = LOWER(?)`,
        [ingredientName],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    let allergens = new Set();

    if (ingredientData?.allergens && ingredientData.allergens.toLowerCase() !== 'none') {
      ingredientData.allergens.split(',').map(a => a.trim()).forEach(a => allergens.add(a));
    }

    if (knownAllergens[ingredientName]) {
      allergens.add(knownAllergens[ingredientName]);
    }

    let calories = ingredientData?.calories_per_100g
      ? ingredientData.calories_per_100g * (ingredientAmount / 100)
      : fallbackCalories[ingredientName]
        ? fallbackCalories[ingredientName] * (ingredientAmount / 100)
        : 0;

    detectedAllergens = new Set([...detectedAllergens, ...allergens]);
    totalCalories += calories;

    enrichedIngredients.push({
      name: ingredientName,
      amount: ingredientAmount,
      allergens: allergens.size > 0 ? Array.from(allergens).join(', ') : "None",
      calories: calories.toFixed(2)
    });
  }

  const allergensList = Array.from(detectedAllergens).join(', ') || "None";
  console.log("🍽️ Enriched ingredients to insert:", enrichedIngredients);

  try {
    const mealId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO meals (name, ingredients, allergens, calories, price, user_id, category, supplier_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          JSON.stringify(enrichedIngredients),
          allergensList,
          totalCalories.toFixed(2),
          price,
          userId,
          category,
          supplierId || null
        ],
        function (err) {
          if (err) {
            console.error("❌ Insert Meal Failed:", err.message);
            reject(err);
          } else {
            resolve(this.lastID); // must use `function` for access to this.lastID
          }
        }
      );
    });

    if (!mealId) {
      console.error("❌ Meal ID is missing. Cannot continue.");
      return res.status(500).json({ success: false, message: "Meal ID not returned from DB." });
    }

    console.log("✅ New meal ID created:", mealId);

    // ✅ Insert into meal_ingredients
    for (const ing of enrichedIngredients) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO meal_ingredients (meal_id, ingredient, quantity) VALUES (?, ?, ?)`,
          [mealId, ing.name, ing.amount],
          (err) => {
            if (err) {
              console.error(`❌ Failed to link ingredient: ${ing.name}`, err.message);
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });
    }

    res.json({
      success: true,
      message: "Meal and ingredients added successfully!",
      meal_id: mealId,
      allergens: allergensList,
      total_calories: totalCalories.toFixed(2),
      ingredients: enrichedIngredients
    });
  } catch (error) {
    console.error("❌ Failed to create meal or link ingredients:", error.message);
    res.status(500).json({ success: false, message: "Failed to create meal and link ingredients." });
  }
});

function calculateMealCost(mealId, callback) {
  const query = `
    SELECT mi.ingredient, mi.quantity, s.price, s.unit, (mi.quantity * s.price) AS cost
    FROM meal_ingredients mi
    JOIN stock s ON LOWER(mi.ingredient) = LOWER(s.ingredient)
    WHERE mi.meal_id = ?
  `;
  db.all(query, [mealId], (err, rows) => {
    if (err) return callback(err);
    const totalCost = rows.reduce((sum, row) => sum + (row.cost || 0), 0);
    callback(null, {
      totalCost: parseFloat(totalCost.toFixed(2)),
      ingredients: rows.map(r => ({ name: r.ingredient, quantity: r.quantity, unit: r.unit }))
    });
  });
}

// Get meals route
app.get('/meals', authenticateToken, (req, res) => {
    const user = req.user || {};
    const userRole = user.role || 'admin'; // Fallback to admin if not authenticated
    const userId = user.id || null;
    const { category } = req.query;

    let query = 'SELECT * FROM meals';
    const params = [];

    if (category) {
        query += ' WHERE category = ?';
        params.push(category);
    }

    if (userRole === 'staff' && userId) {
        // If category is already in query, add AND. Otherwise start WHERE.
        query += category ? ' AND' : ' WHERE';
        query += ' user_id = ?';
        params.push(userId);
    }

    pool.query(query, params, (err, rows) => {
        if (err) {
            console.error('❌ Error fetching meals:', err.message);
            return res.status(500).json({ error: 'Error fetching meals.' });
        }

        res.status(200).json(rows);
    });
});

app.get('/meals/paginated', authenticateToken, (req, res) => {
  console.log('Paginated meals request received');
  console.log('User:', req.user);
  console.log('Query Params:', req.query);

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  const query = `
    SELECT m.*, 
      (
        SELECT GROUP_CONCAT(DISTINCT s.allergens)
        FROM stock s
        WHERE INSTR(LOWER(m.ingredients), LOWER(s.ingredient)) > 0
      ) AS detected_allergens
    FROM meals m
    LIMIT ? OFFSET ?
  `;

  const countQuery = `SELECT COUNT(*) as total FROM meals`;

  pool.query(query, [limit, offset], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching meals:', err.message);
      return res.status(500).json({ error: 'Error fetching meals.' });
    }

    db.get(countQuery, [], (countErr, countRow) => {
      if (countErr) {
        console.error('❌ Error counting meals:', countErr.message);
        return res.status(500).json({ error: 'Error counting meals.' });
      }

      let processedCount = 0;

      rows.forEach((meal, index) => {
        // Allergen fix
        meal.allergens = meal.detected_allergens || 'No allergens detected';
        delete meal.detected_allergens;

        // Calculate cost
        calculateMealCost(meal.id, (err, costData) => {
          if (!err && costData) {
            meal.plate_cost = costData.totalCost;
            meal.suggested_price = parseFloat((costData.totalCost * 3).toFixed(2));
            meal.profit = parseFloat((meal.price - costData.totalCost).toFixed(2));
            meal.ingredients_info = costData.ingredients;
          } else {
            meal.plate_cost = null;
            meal.suggested_price = null;
            meal.profit = null;
          }

          processedCount++;

          // Only return once all meals have been processed
          if (processedCount === rows.length) {
            console.log('✅ Total meals count:', countRow.total);
            return res.status(200).json({
              meals: rows,
              total: countRow.total,
              page,
              limit,
            });
          }
        });
      });

      // In case there are no meals at all
      if (rows.length === 0) {
        return res.status(200).json({
          meals: [],
          total: countRow.total,
          page,
          limit,
        });
      }
    });
  });
});

app.get('/analytics', (req, res) => {
  const query = `SELECT id, calories, ingredients, price FROM meals`;
  pool.query(query, [], (err, rows) => {
    if (err) return res.status(500).send('Error retrieving analytics data.');

    const totalMeals = rows.length;
    const totalCalories = rows.reduce((sum, m) => sum + (Number(m.calories) || 0), 0);
    const averageCalories = totalMeals ? Number(totalCalories / totalMeals).toFixed(2) : 0;

    // count ingredients (ingredients is JSON in your code)
    const ingredientCounts = {};
    for (const meal of rows) {
      let list = [];
      try {
        const parsed = JSON.parse(meal.ingredients || '[]');
        if (Array.isArray(parsed)) list = parsed.map(i => (i.name || '').toString().trim().toLowerCase()).filter(Boolean);
      } catch (_) {}
      for (const name of list) {
        ingredientCounts[name] = (ingredientCounts[name] || 0) + 1;
      }
    }

    const mostCommonIngredient =
      Object.entries(ingredientCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    res.status(200).json({ totalMeals, averageCalories, mostCommonIngredient });
  });
});


app.get('/analytics/daily', authenticateToken, (req, res) => {
    const query = `
        SELECT 
            DATE(created_at) AS date, 
            COUNT(*) AS totalMeals 
        FROM meals 
        GROUP BY DATE(created_at)
    `;

    pool.query(query, [], (err, rows) => {
        if (err) {
            console.error('Error fetching daily analytics:', err.message);
            return res.status(500).send('Error fetching daily analytics.');
        }

        console.log('Fetched Daily Analytics:', rows);
        res.status(200).json(rows);
    });
});

app.get('/analytics/meals', authenticateToken, (req, res) => {
    const userRole = req.user.role;

    let query = `SELECT * FROM meals`;
    let params = [];

    if (userRole === 'staff') {
        query += ` WHERE user_id = ?`;
        params.push(req.user.id);
    }

    pool.query(query, params, (err, rows) => {
        if (err) {
            console.error('Error fetching meals for analytics:', err.message);
            return res.status(500).send('Error fetching meals for analytics.');
        }

        const totalMeals = rows.length;
        const totalCalories = rows.reduce((sum, meal) => sum + (meal.calories || 0), 0);
        const averageCalories = totalMeals > 0 ? (totalCalories / totalMeals).toFixed(2) : 0;

        res.status(200).json({ totalMeals, averageCalories });
    });
});

app.delete('/meals/:id', authenticateToken, checkRoles(['admin', 'staff']), (req, res) => {
    const { id } = req.params;
    const query = `DELETE FROM meals WHERE id = ?`;
    
    db.run(query, [id], function (err) {
        if (err) {
            console.error('Error deleting meal:', err.message);
            return res.status(500).send('Error deleting meal');
        }
        if (this.changes === 0) {
            return res.status(404).send('Meal not found.');
        }
        res.status(200).send('Meal deleted successfully');
    });
});

app.put('/meals/:id', authenticateToken, checkRoles(['admin', 'staff']), (req, res) => {
    const { id } = req.params;
    const { name, ingredients, allergens, calories } = req.body;

    const query = `
        UPDATE meals
        SET name = ?, ingredients = ?, allergens = ?, calories = ?
        WHERE id = ?
    `;

    db.run(query, [name, ingredients, allergens, calories, id], function (err) {
        if (err) {
            console.error('Error updating meal:', err.message);
            return res.status(500).send('Error updating meal');
        }
        if (this.changes === 0) {
            return res.status(404).send('Meal not found.');
        }
        res.status(200).send('Meal updated successfully');
    });
});

// Add ingredient to stock (with optional expiry date)
app.post('/stock', authenticateToken, checkRoles(['admin', 'staff']), (req, res) => {
  let {
    ingredient,
    quantity = 1,
    allergens = "None",
    calories_per_100g = 0,
    expiry_date = null,
    price = 0,
    quantity_parsed = 1,
    unit = '',
    type = 'ingredient' // ✅ NEW LINE
  } = req.body;

console.log('📦 Stock POST Payload:', req.body);

  if (!ingredient || quantity === undefined) {
    return res.status(400).json({ error: 'Ingredient and quantity are required' });
  }

  ingredient = ingredient.trim().toLowerCase();
  unit = unit.toLowerCase();

  // 🧠 Nova calculates real quantity (in grams/ml/units)
  let finalQuantity = quantity_parsed;

  if (unit === 'kg') finalQuantity = quantity_parsed * 1000;
  else if (unit === 'g') finalQuantity = quantity_parsed;
  else if (unit === 'l') finalQuantity = quantity_parsed * 1000;
  else if (unit === 'ml') finalQuantity = quantity_parsed;
  else if (unit === 'unit' || unit === 'ptn' || unit === 'x') finalQuantity = quantity_parsed;

  finalQuantity = finalQuantity * quantity; // scale by number of packs

  const displayUnit = (unit === 'kg' || unit === 'g') ? 'g' :
                    (unit === 'l' || unit === 'ml') ? 'ml' :
                    (unit === 'ptn' || unit === 'unit' || unit === 'x') ? 'units' : 'units';

console.log(`✅ Added stock: ${ingredient} → ${finalQuantity}${displayUnit} (from ${quantity} × ${quantity_parsed}${unit})`);

    const query = `
    INSERT INTO stock (ingredient, quantity, allergens, calories_per_100g, expiry_date, price, type) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ingredient)
    DO UPDATE SET 
      quantity = stock.quantity + excluded.quantity,
      allergens = excluded.allergens,
      calories_per_100g = excluded.calories_per_100g,
      expiry_date = excluded.expiry_date,
      price = excluded.price,
      type = excluded.type
  `;

  db.run(
    query,
    [
      ingredient,
      finalQuantity,
      allergens,
      calories_per_100g,
      expiry_date,
      price,
      type
    ],
    function (err) {
      if (err) {
        console.error('❌ Error adding stock:', err.message);
        return res.status(500).json({ error: 'Error adding stock' });
      }
      console.log(`✅ Added stock: ${ingredient} → ${finalQuantity} (${quantity_parsed} ${unit} × ${quantity})`);
      res.status(201).json({ id: this.lastID, message: '✅ Stock added successfully' });
    }
  );
});

// Deduct stock when a meal is ordered
const deductStock = (ingredientsList) => {
    ingredientsList.forEach(ingredient => {
        const query = `
            UPDATE stock 
            SET quantity = quantity - 1 
            WHERE ingredient = ? AND quantity > 0
        `;

        db.run(query, [ingredient], function (err) {
            if (err) {
                console.error('Error updating stock:', err.message);
            }
        });
    });
};

// Get low stock warnings
app.get('/stock/low', (req, res) => {
    const threshold = 5; // Adjust the threshold based on your needs

    const query = `SELECT * FROM stock WHERE quantity < ?`;
    pool.query(query, [threshold], (err, rows) => {
        if (err) {
            console.error('Error fetching low stock items:', err.message);
            return res.status(500).send('Error fetching low stock items.');
        }

        if (rows.length === 0) {
            return res.status(200).json({ message: 'All ingredients are sufficiently stocked.' });
        }

        res.status(200).json(rows);
    });
});



// Get all stock items
app.get('/stock', authenticateToken, (req, res) => {
    const query = `SELECT * FROM stock`;
    pool.query(query, [], (err, rows) => {
        if (err) {
            console.error('Error fetching stock:', err.message);
            return res.status(500).json({ error: 'Error fetching stock' });
        }
        res.status(200).json(rows);
    });
});

// Update stock quantity
app.put('/stock/:id', authenticateToken, checkRoles(['admin', 'staff']), (req, res) => {
    const { id } = req.params;
    const updates = req.body; // All fields you send from frontend

    if (!updates || Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No data to update.' });
    }

    const allowedFields = ['ingredient', 'quantity', 'allergens', 'calories_per_100g', 'expiry_date', 'price'];
    const fieldsToUpdate = [];
    const values = [];

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            fieldsToUpdate.push(`${field} = ?`);
            values.push(updates[field]);
        }
    }

    if (fieldsToUpdate.length === 0) {
        return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const query = `
        UPDATE stock 
        SET ${fieldsToUpdate.join(', ')} 
        WHERE id = ?
    `;

    values.push(id);

    db.run(query, values, function (err) {
        if (err) {
            console.error('Error updating stock:', err.message);
            return res.status(500).json({ error: 'Error updating stock.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Stock item not found.' });
        }
        res.status(200).json({ message: '✅ Stock updated successfully!' });
    });
});

// Delete stock item
app.delete('/stock/:id', authenticateToken, checkRoles(['admin']), (req, res) => {
    const { id } = req.params;

    const query = `DELETE FROM stock WHERE id = ?`;
    db.run(query, [id], function (err) {
        if (err) {
            console.error('Error deleting stock:', err.message);
            return res.status(500).json({ error: 'Error deleting stock' });
        }
        res.status(200).json({ message: 'Stock deleted successfully' });
    });
});
  
app.post('/orders', async (req, res) => {
  const { meal_name, quantity, total_price, table_number, options, note, special_requests } = req.body;
  const order_type = req.body.order_type || 'dine-in';
  if (!meal_name || !quantity || total_price === undefined) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  console.log(`🧪 INSERTING ORDER ITEM: { meal_name: '${meal_name}', quantity: ${quantity}, total_price: ${total_price} }`);

  try {
    db.get(
      `SELECT id, price, category FROM meals WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))`,
      [meal_name],
      (err, meal) => {
        if (err || !meal) {
          console.error("❌ Meal not found:", err?.message);
          return res.status(404).json({ error: 'Meal not found.' });
        }

        const mealId = meal.id;
        const pricePerUnit = meal.price;
        const category = meal.category || 'meals';

        pool.query(
          `SELECT ingredient, quantity FROM meal_ingredients WHERE meal_id = ?`,
          [mealId],
          (err, mealIngredients) => {
            if (err || !mealIngredients || mealIngredients.length === 0) {
              console.error(`❌ No ingredients found for meal_id: ${mealId} (${meal_name})`);
              return res.status(400).json({ error: 'No ingredients linked to this meal.' });
            }

            const missingStock = [];

            const checkStock = mealIngredients.map((ing) => {
              return new Promise((resolve) => {
                db.get(
                  `SELECT quantity FROM stock WHERE LOWER(ingredient) = LOWER(?)`,
                  [ing.ingredient.toLowerCase()],
                  (err, row) => {
                    if (err || !row || row.quantity < ing.quantity * quantity) {
                      missingStock.push(ing.ingredient);
                    }
                    resolve();
                  }
                );
              });
            });

            Promise.all(checkStock).then(() => {
              if (missingStock.length > 0) {
                return res.status(400).json({
                  success: false,
                  message: `Missing or low stock: ${missingStock.join(', ')}`,
                  missingIngredients: missingStock,
                });
              }

              // ✅ Deduct stock
              mealIngredients.forEach((ing) => {
                const used = ing.quantity * quantity;
               db.get(
  `SELECT quantity FROM stock WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
  [ing.ingredient],
  (err, row) => {
    if (err || !row) {
      console.error(`❌ Stock not found for: ${ing.ingredient}`);
    } else {
      const beforeQty = row.quantity;
      const used = ing.quantity * quantity;
      const afterQty = beforeQty - used;

      if (afterQty < 0) {
        console.warn(`⚠️ Stock for ${ing.ingredient} will go negative: ${afterQty}`);
      }

      db.run(
        `UPDATE stock SET quantity = ? WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
        [afterQty, ing.ingredient],
        (err) => {
          if (err) {
            console.error(`❌ Failed to update stock for ${ing.ingredient}:`, err.message);
          } else {
            console.log(`✅ Deducted ${used} from ${ing.ingredient} (was ${beforeQty} → now ${afterQty})`);
          }
        }
      );
    }
  }
); 
              });

            // ✅ Place order (now saving options/note/special_requests)
  db.run(
    `
    INSERT INTO orders (
      meal_name, quantity, price_per_unit, total_price,
      table_number, order_status, paid, category, order_type,
      options, note, special_requests
    )
    VALUES (?, ?, ?, ?, ?, 'Pending', 0, ?, ?, ?, ?, ?)
  `,
    [
      meal_name.trim(),
      quantity,
      pricePerUnit,
      total_price,
      table_number || 'Takeaway',
      category,
      order_type,
      // new fields:
      typeof options === 'object' ? JSON.stringify(options) : (options || null),
      note || null,
      special_requests || null
    ],
    function (err) {
      if (err) {
        console.error('❌ Order insert failed:', err.message);
        return res.status(500).json({ error: 'Order placement failed.' });
      }
      console.log(`✅ Order placed: ${meal_name} x${quantity}`);
      return res.status(201).json({ success: true, message: 'Order placed successfully.' });
    }
  );
});
  
          }
        );
      }
    );
  } catch (error) {
    console.error('❌ Server error:', error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

  app.put('/stock/:id/price', authenticateToken, (req, res) => {
    const { price } = req.body;
    const { id } = req.params;
  
    db.run(`UPDATE stock SET price = ? WHERE id = ?`, [price, id], function (err) {
      if (err) return res.status(500).send('Update failed');
      res.send('Price updated');
    });
  });

const checkStockAndAlert = async (ingredient) => {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database('./database.db');

        const threshold = 5; // Low stock alert threshold

        db.get(`SELECT quantity FROM stock WHERE ingredient = ?`, [ingredient], (err, row) => {
            if (err) {
                console.error("❌ Error checking stock:", err.message);
                reject(err);
                return;
            }

            if (!row) {
                console.log(`❌ No stock found for ${ingredient}.`);
                resolve();
                return;
            }

            console.log(`🔎 Checking stock for ${ingredient}: ${row.quantity} left`);

            if (row.quantity <= threshold) {
                console.warn(`⚠️ Low Stock Alert: ${ingredient} - Only ${row.quantity} left!`);

                db.run(
                    `INSERT INTO stock_alerts (ingredient, quantity, alert_message, created_at) 
                     VALUES (?, ?, ?, datetime('now')) 
                     ON CONFLICT(ingredient) DO UPDATE 
                     SET quantity = ?, alert_message = ?, created_at = datetime('now')`,
                    [ingredient, row.quantity, `Low stock: Only ${row.quantity} left!`, row.quantity, `Low stock: Only ${row.quantity} left!`],
                    function (err) {
                        if (err) {
                            console.error("❌ Error saving stock alert:", err.message);
                            reject(err);
                        } else {
                            console.log(`✅ Stock alert saved for ${ingredient}`);
                            resolve();
                        }
                    }
                );
            } else {
                console.log(`✅ Stock is sufficient for ${ingredient}, no alert needed.`);
                resolve();
            }
        });

        db.close();
    });
};

app.post('/orders/place', async (req, res) => {
    const { ingredient } = req.body;
    const orderQuantity = parseInt(req.body.quantity, 10) || 1;

    if (!ingredient) {
        return res.status(400).json({ success: false, message: "Missing ingredient name." });
    }

    const db = new sqlite3.Database('./database.db');

    db.get(`SELECT quantity FROM stock WHERE ingredient = ?`, [ingredient], (err, row) => {
        if (err) {
            console.error("❌ Database error:", err.message);
            return res.status(500).json({ success: false, message: "Database error." });
        }

        if (!row || row.quantity < orderQuantity) {
            console.warn(`❌ Not enough stock for ${ingredient}. Available: ${row ? row.quantity : 0}`);
            return res.status(400).json({ success: false, message: `Not enough stock for ${ingredient}. Available: ${row ? row.quantity : 0}` });
        }

        const updatedStock = row.quantity - orderQuantity;
        console.log(`✅ Stock updated for ${ingredient} - Remaining: ${updatedStock}`);

        db.run(
  `UPDATE stock SET quantity = quantity - ? WHERE ingredient = ? AND quantity >= ?`,
  [orderQuantity, ingredient, orderQuantity],
  async function (err) {
    if (err) {
      console.error("❌ Order failed:", err.message);
      return res.status(500).json({ success: false, message: "Order failed." });
    }
    if (this.changes === 0) {
      return res.status(400).json({ success: false, message: `Not enough stock for ${ingredient}.` });
    }

    try {
      await checkStockAndAlert(ingredient);
    } catch (err2) {
      console.error("❌ Stock alert check failed:", err2.message);
    }

    return res.json({ success: true, message: `Order successfully placed: ${ingredient}, Quantity: ${orderQuantity}` });
  }
);             
    });

    db.close();
});

app.get('/stock/alerts', (req, res) => {
    const db = new sqlite3.Database('./database.db');

    console.log("🔍 Checking for low-stock alerts...");

    pool.query(`SELECT * FROM stock_alerts ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching stock alerts:", err.message);
            return res.status(500).json({ success: false, message: "Error fetching stock alerts." });
        }

        if (rows.length === 0) {
            console.log("ℹ️ No low-stock alerts found.");
            res.json({ success: true, message: "No low-stock alerts." });
        } else {
            console.log("📢 Low-stock alerts found:", rows);
            res.json({ success: true, alerts: rows });
        }
    });

    db.close();
});

app.post('/ingredients/scanned', async (req, res) => {
    const { ingredientName } = req.body;

    if (!ingredientName) {
        return res.status(400).json({ error: "Ingredient name is required." });
    }

    try {
        db.get(`SELECT allergens, calories_per_100g FROM stock WHERE LOWER(ingredient) = LOWER(?)`, 
            [ingredientName.trim().toLowerCase()], (err, row) => {
            
            if (err) {
                console.error("❌ Error fetching scanned ingredient:", err.message);
                return res.status(500).json({ error: "Database error." });
            }

            if (!row) {
                return res.status(404).json({ success: false, message: "Ingredient not found in stock." });
            }
            res.status(200).json({ 
                success: true, 
                allergens: row.allergens || "None", 
                calories: row.calories_per_100g ? row.calories_per_100g.toFixed(2) : "0.00" 
            });            
        });

    } catch (error) {
        console.error("❌ Server error:", error);
        res.status(500).json({ error: "Internal server error." });
    }
});

// Convert HEIC to PNG
app.post('/convert-heic', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const inputFilePath = req.file.path;
        const outputFilePath = `${inputFilePath}.png`;

        // Convert HEIC to PNG
        await sharp(inputFilePath)
            .toFormat('png')
            .toFile(outputFilePath);

        // Delete original HEIC to save storage
        fs.unlinkSync(inputFilePath);

        // Send back the converted image URL
        res.json({ convertedImageUrl: `http://localhost:5000/uploads/${path.basename(outputFilePath)}` });

    } catch (error) {
        console.error('❌ Error converting HEIC:', error);
        res.status(500).json({ error: 'Failed to process image' });
    }
});

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/scan-ingredient', authenticateToken, async (req, res) => {
    const { name, allergens, calories } = req.body;

    if (!name) {
        return res.status(400).json({ success: false, message: "Ingredient name is required." });
    }

    try {
        // ✅ **Ensure quantity is set (default to 1 if missing)**
        let defaultQuantity = 1;

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO stock (ingredient, allergens, calories_per_100g, quantity) 
                 VALUES (?, ?, ?, ?) 
                 ON CONFLICT(ingredient) DO UPDATE SET allergens = excluded.allergens, calories_per_100g = excluded.calories_per_100g, quantity = stock.quantity + ?`,
                [name.toLowerCase(), allergens, calories, defaultQuantity, defaultQuantity],
                function (err) {
                    if (err) reject(err);
                    else resolve();
                }
            );
        });

        res.json({ success: true, message: "Ingredient added to stock successfully!" });

    } catch (error) {
        console.error("❌ Error processing image:", error);
        res.status(500).json({ success: false, message: "Error processing ingredient scan." });
    }
});

// ✅ Add This to `server.js` If Missing
app.get('/suppliers', (req, res) => {
    const query = "SELECT * FROM suppliers";  // Ensure you have a suppliers table!

    pool.query(query, [], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching suppliers:", err.message);
            return res.status(500).json({ error: "Error fetching suppliers." });
        }
        res.status(200).json(rows);
    });
});

app.get('/stock/expiring-soon', (req, res) => {
    const today = new Date();
    const twoDaysFromNow = new Date(today.setDate(today.getDate() + 2)).toISOString();

    const query = `
        SELECT * FROM stock
        WHERE expiry_date IS NOT NULL AND expiry_date <= ?
        ORDER BY expiry_date ASC
    `;

    pool.query(query, [twoDaysFromNow], (err, rows) => {
        if (err) {
            console.error("❌ Error fetching expiring stock:", err.message);
            return res.status(500).json({ error: "Error fetching expiring stock." });
        }

        res.status(200).json(rows);
    });
});
   
  
  app.get('/orders/by-table/:name', (req, res) => {
    const tableName = req.params.name;
  
    const query = `
    SELECT * FROM orders 
    WHERE table_number = ? AND paid = 0
    ORDER BY created_at ASC
  `;
  
    pool.query(query, [tableName], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching orders for table:", err.message);
        return res.status(500).json({ error: "Failed to fetch table orders" });
      }
  
      res.status(200).json(rows);
    });
  });
  
  // ✅ Close all unpaid orders for a table and free the table
app.post('/orders/close', (req, res) => {
    const { table_number } = req.body;
  
    if (!table_number) {
      return res.status(400).json({ error: "Table number is required" });
    }
  
    const markPaidQuery = `UPDATE orders SET paid = 1 WHERE table_number = ? AND paid = 0`;
    const freeTableQuery = `UPDATE tables SET status = 'free', active_order_id = NULL WHERE name = ?`;
  
    db.run(markPaidQuery, [table_number], function (err) {
      if (err) {
        console.error("❌ Failed to mark orders as paid:", err.message);
        return res.status(500).json({ error: "Failed to mark orders as paid" });
      }
  
      db.run(freeTableQuery, [table_number], (err2) => {
        if (err2) {
          console.error("❌ Failed to free table:", err2.message);
          return res.status(500).json({ error: "Failed to free table" });
        }
  
        console.log(`✅ Orders marked as paid & table '${table_number}' set to free`);
        res.json({ success: true });
      });
    });
  });  
  
  app.post('/tables/:tableName/close', (req, res) => {
    const { tableName } = req.params;
  
    db.run(
      `UPDATE tables SET status = 'free', active_order_id = NULL WHERE name = ?`,
      [tableName],
      function (err) {
        if (err) {
          console.error("❌ Error closing table:", err.message);
          return res.status(500).json({ error: "Failed to close table." });
        }
  
        console.log(`✅ Table ${tableName} marked as free.`);
        res.json({ success: true, message: `Table ${tableName} closed.` });
      }
    );
  });
  
// ✅ Get all tables
app.get('/tables', (req, res) => {
    pool.query('SELECT * FROM tables ORDER BY id ASC', [], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching tables:", err.message);
        return res.status(500).json({ error: "Error fetching tables" });
      }
      res.json(rows);
    });
  });
  
app.get('/orders', (req, res) => {
  const { table, paid } = req.query;

  let query = `
    SELECT o.*, ob.delivery_status, ob.delivery_code, m.id AS meal_id
    FROM orders o
    LEFT JOIN order_batches ob ON o.batch_id = ob.id
    LEFT JOIN meals m ON LOWER(TRIM(o.meal_name)) = LOWER(TRIM(m.name))
  `;
  const params = [];

  if (table || paid !== undefined) {
    query += ` WHERE`;
    if (table) {
      query += ` o.table_number = ?`;
      params.push(table);
    }
    if (paid !== undefined) {
      if (table) query += ` AND`;
      query += ` o.paid = ?`;
      params.push(paid);
    }
  }

  query += ` ORDER BY o.created_at ASC`;

  pool.query(query, params, async (err, orders) => {
    if (err) {
      console.error('❌ Failed to fetch orders:', err.message);
      return res.status(500).json({ error: 'Failed to fetch orders.' });
    }

    // ⬇️ For each order, attach ingredients
    const enriched = await Promise.all(
      orders.map(order => {
        return new Promise((resolve) => {
const iq = `SELECT ingredient AS ingredient_name, quantity FROM meal_ingredients WHERE meal_id = ?`;
          pool.query(iq, [order.meal_id], (err, ingredients) => {
            if (err) {
              console.error(`❌ Could not fetch ingredients for meal_id ${order.meal_id}`);
              return resolve({ ...order, ingredients: [] });
            }
            resolve({ ...order, ingredients });
          });
        });
      })
    );

    res.json(enriched);
  });
});
  
  app.delete('/orders/clear-unpaid/:table', (req, res) => {
    const tableParam = decodeURIComponent(req.params.table);
    const cleanTable = tableParam.replace(/^Table\s*/i, '').trim();
  
    const query = `
      DELETE FROM orders 
      WHERE (table_number = ? OR table_number = ?) 
        AND paid = 0
    `;
  
    db.run(query, [cleanTable, tableParam], function (err) {
      if (err) {
        console.error('❌ Failed to clear unpaid orders:', err.message);
        return res.status(500).json({ success: false, message: 'Failed to clear unpaid orders' });
      }
  
      console.log(`🧹 Cleared ${this.changes} unpaid orders for: ${tableParam}`);
      res.json({ success: true, message: `Unpaid orders cleared for ${tableParam}` });
    });
  });   
  
  app.delete('/orders/:id', (req, res) => {
    const id = req.params.id;
  
    const query = `DELETE FROM orders WHERE id = ?`;
    db.run(query, [id], function (err) {
      if (err) {
        console.error('❌ Failed to delete order:', err.message);
        return res.status(500).json({ error: 'Failed to delete order' });
      }
  
      if (this.changes === 0) {
        return res.status(404).json({ message: 'Order not found' });
      }
  
      res.status(200).json({ message: '✅ Order deleted' });
    });
  });  

  app.delete('/orders/clear-all', (req, res) => {
    db.run(`DELETE FROM orders`, [], function (err) {
      if (err) {
        console.error("❌ Failed to clear all orders:", err.message);
        return res.status(500).json({ success: false, message: "Failed to clear all orders" });
      }
      console.log(`🧹 Cleared ${this.changes} orders`);
      res.json({ success: true, message: "All orders cleared." });
    });
  });

  app.post('/orders/grouped', authenticateToken, async (req, res) => {
  const { table_number, items } = req.body;
  const order_type = req.body.order_type || 'dine-in';


 if ((!table_number && order_type !== 'delivery' && order_type !== 'collection') || !items || !items.length) {
  return res.status(400).json({ error: 'Table number and order items are required.' });
}

  const batchId = uuidv4();

  try {
    // Insert batch
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO order_batches (id, table_number) VALUES (?, ?)`,
        [batchId, table_number],
        (err) => (err ? reject(err) : resolve())
      );
    });

    for (const item of items) {
      const rawName = item.meal_name || '';
      const meal_name = rawName.trim();
      const quantity = parseInt(item.quantity) || 0;
      const total_price = parseFloat(item.total_price) || 0;
      const price = parseFloat(item.price) || (total_price / quantity) || 0;
      const category = item.category || 'meals';
      const options = item.options ?? item.customizations ?? item.choices ?? null;
const note = item.note ?? item.notes ?? item.comment ?? item.special_instructions ?? null;
const special_requests = item.special_requests ?? null;

      console.log("🧪 INSERTING ORDER ITEM:", {
        meal_name,
        quantity,
        total_price,
        price,
        category
      });

      // Save order
      await new Promise((resolve, reject) => {
  db.run(
    `INSERT INTO orders (
       meal_name, quantity, total_price, table_number,
       order_status, paid, price, batch_id, category, order_type,
       options, note, special_requests
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meal_name, quantity, total_price, table_number,
      'Pending', 0, price, batchId, category, order_type,
      typeof options === 'object' ? JSON.stringify(options) : options,
      note,
      special_requests
    ],
    (err) => (err ? reject(err) : resolve())
  );
});

      // ✅ Deduct stock
      if (category === 'drinks' || category === 'desserts') {
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE stock SET quantity = quantity - ? WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
            [quantity, meal_name],
            (err) => {
              if (err) {
                console.error(`❌ Failed to update stock for ${meal_name}:`, err.message);
                reject(err);
              } else {
                console.log(`✅ Deducted stock for drink/dessert: ${meal_name}`);
                resolve();
              }
            }
          );
        });
      } else if (category === 'meals') {
        // 🔍 Get meal_id from meals table
        const meal = await new Promise((resolve, reject) => {
          db.get(
            `SELECT id FROM meals WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))`,
            [meal_name],
            (err, row) => (err ? reject(err) : resolve(row))
          );
        });

        if (!meal) {
          console.error(`❌ Meal not found for name: '${meal_name}'`);
          continue;
        }

        const mealIngredients = await new Promise((resolve, reject) => {
          pool.query(
            `SELECT ingredient, quantity FROM meal_ingredients WHERE meal_id = ?`,
            [meal.id],
            (err, rows) => (err ? reject(err) : resolve(rows))
          );
        });

        if (!Array.isArray(mealIngredients) || mealIngredients.length === 0) {
          console.warn(`⚠️ No ingredients found for meal_id: ${meal.id} (${meal_name})`);
          continue;
        }

        for (const ing of mealIngredients) {
          const usedQty = ing.quantity * quantity;

          const stockRow = await new Promise((resolve, reject) => {
            db.get(
              `SELECT quantity FROM stock WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
              [ing.ingredient],
              (err, row) => (err ? reject(err) : resolve(row))
            );
          });

          if (!stockRow || typeof stockRow.quantity !== 'number') {
            console.warn(`❌ Ingredient not found or invalid stock: ${ing.ingredient}`);
            continue;
          }

          const remainingQty = stockRow.quantity - usedQty;

          if (remainingQty < 0) {
            console.warn(`⚠️ Stock for ${ing.ingredient} would go negative (${stockRow.quantity} - ${usedQty})`);
          }

          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE stock SET quantity = ? WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))`,
              [remainingQty, ing.ingredient],
              function (err) {
                if (err) {
                  console.error(`❌ Failed to update stock for ${ing.ingredient}:`, err.message);
                  reject(err);
                } else {
                  console.log(`✅ Updated ${ing.ingredient}: ${stockRow.quantity} → ${remainingQty}`);
                  resolve();
                }
              }
            );
          });
        }
      }
    }

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE tables SET status = 'occupied' WHERE name = ?`,
        [table_number],
        (err) => (err ? reject(err) : resolve())
      );
    });

    console.log('✅ Stock updated after order placement');

    res.status(201).json({
      success: true,
      message: "Grouped order placed successfully!",
      batch_id: batchId
    });

  } catch (err) {
    console.error("❌ Failed to place grouped order:", err.message);
    res.status(500).json({ error: "Failed to process grouped order." });
  }
});   
  
app.get('/kds/meals', (req, res) => {
  const query = `
    SELECT o.*, ob.delivery_status, ob.delivery_code 
    FROM orders o
    LEFT JOIN order_batches ob ON o.batch_id = ob.id
    WHERE o.category = 'meals' AND o.order_status = 'Pending'
    ORDER BY o.created_at ASC
  `;

  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching kitchen orders:", err.message);
      return res.status(500).json({ error: "Failed to fetch kitchen orders" });
    }

    res.status(200).json(rows);
  });
});

app.get('/kds/drinks', (req, res) => {
  const query = `
    SELECT o.*, ob.delivery_status, ob.delivery_code 
    FROM orders o
    LEFT JOIN order_batches ob ON o.batch_id = ob.id
    WHERE o.category = 'drinks' AND o.order_status = 'Pending'
    ORDER BY o.created_at ASC
  `;

  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching drinks:", err.message);
      return res.status(500).json({ error: "Failed to fetch drinks" });
    }

    res.status(200).json(rows);
  });
});

app.get('/kds/desserts', (req, res) => {
  const query = `
    SELECT o.*, ob.delivery_status, ob.delivery_code 
    FROM orders o
    LEFT JOIN order_batches ob ON o.batch_id = ob.id
    WHERE o.category = 'desserts' AND o.order_status = 'Pending'
    ORDER BY o.created_at ASC
  `;

  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error("❌ Error fetching desserts:", err.message);
      return res.status(500).json({ error: "Failed to fetch desserts" });
    }

    res.status(200).json(rows);
  });
});

app.get("/categories", (req, res) => {
  const { type } = req.query;
  let sql = "SELECT * FROM categories";
  const params = [];

  if (type) {
    const t = String(type).toLowerCase().trim();
    const normalized =
      t.startsWith('meal')   ? 'meals'   :
      t.startsWith('drink')  ? 'drinks'  :
      t.startsWith('dessert')? 'desserts': null;

    if (normalized) {
      sql += " WHERE type = ? ORDER BY active DESC, sort_order ASC, name ASC";
      params.push(normalized);
    } else {
      sql += " ORDER BY type ASC, active DESC, sort_order ASC, name ASC";
    }
  } else {
    sql += " ORDER BY type ASC, active DESC, sort_order ASC, name ASC";
  }

  pool.query(sql, params, (err, rows) => {
    if (err) {
      console.error("❌ Error fetching categories:", err.message);
      return res.status(500).json({ error: "Failed to fetch categories" });
    }
    res.json(rows);
  });
});
  
  // Add new category
app.post('/categories', async (req, res) => {
  const { name, type, icon } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'Missing category name or type' });

  // normalize type (accept singular/plural)
  const t = String(type).toLowerCase().trim();
  const normalized =
    t.startsWith('meal')   ? 'meals'   :
    t.startsWith('drink')  ? 'drinks'  :
    t.startsWith('dessert')? 'desserts': null;

  if (!normalized) return res.status(400).json({ error: 'Invalid type. Use meals/drinks/desserts' });

  try {
    await db.run(
      'INSERT INTO categories (name, type, icon) VALUES (?, ?, ?)',
      [name.trim(), normalized, icon || '']
    );
    res.json({ success: true, message: 'Category added' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      res.status(409).json({ error: 'Category already exists' });
    } else {
      console.error('❌ Category insert error:', err.message);
      res.status(500).json({ error: 'Failed to add category' });
    }
  }
});
  
// PUT /categories/:id  (rename, icon, sort, active)
app.put('/categories/:id', (req, res) => {
  const { id } = req.params;
  const { name, icon, sort_order, active } = req.body;
  const fields = []; const vals = [];
  if (name !== undefined) { fields.push('name = ?'); vals.push(name); }
  if (icon !== undefined) { fields.push('icon = ?'); vals.push(icon); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); vals.push(sort_order); }
  if (active !== undefined) { fields.push('active = ?'); vals.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

  db.run(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`, [...vals, id], function (err) {
    if (err) {
      console.error("❌ Failed to update category:", err.message);
      return res.status(500).json({ error: 'Failed to update category' });
    }
    res.json({ success: true, changes: this.changes });
  });
});


  app.delete('/stock/expired', (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const query = `DELETE FROM stock WHERE expiry_date IS NOT NULL AND expiry_date < ?`;

    db.run(query, [today], function (err) {
        if (err) {
            console.error("❌ Failed to delete expired items:", err.message);
            return res.status(500).json({ error: "Failed to delete expired stock." });
        }

        console.log(`🗑️ Deleted ${this.changes} expired stock items.`);
        res.status(200).json({ success: true, message: `Deleted ${this.changes} expired stock items.` });
    });
});

app.delete('/stock/expired/:id', (req, res) => {
    const { id } = req.params;

    db.run(`DELETE FROM stock WHERE id = ?`, [id], function (err) {
        if (err) {
            console.error("❌ Failed to delete expired item:", err.message);
            return res.status(500).json({ error: "Failed to delete expired stock item." });
        }

        if (this.changes === 0) {
            return res.status(404).json({ message: "Item not found or already deleted." });
        }

        res.status(200).json({ success: true, message: "✅ Expired item deleted." });
    });
});

app.get('/meals/:id/cost', authenticateToken, (req, res) => {
  const { id } = req.params;
  const mealQuery = `SELECT ingredients FROM meals WHERE id = ?`;

  console.log("Fetching cost for meal:", id);

  db.get(mealQuery, [id], (err, meal) => {
    if (err || !meal) {
      console.error('❌ Error fetching meal:', err?.message);
      return res.status(404).json({ error: 'Meal not found.' });
    }

    let ingredients = [];
    try {
      ingredients = JSON.parse(meal.ingredients);
    } catch (error) {
      console.error('❌ Error parsing ingredients JSON:', error.message);
      return res.status(500).json({ error: 'Invalid ingredients format.' });
    }

    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return res.status(400).json({ error: 'No ingredients found.' });
    }

    let totalCost = 0;
    const breakdown = [];

    const promises = ingredients.map(ing => {
      return new Promise((resolve) => {
        const baseName = ing.name.toLowerCase().replace(/\d+(kg|g|ml|l|pt|pcs)?/gi, '').trim();

       db.get(
  `SELECT price, ingredient FROM stock WHERE LOWER(ingredient) LIKE '%' || LOWER(?) || '%'`,
  [baseName],
  (err, stockItem) => {
    if (err || !stockItem) {
      console.warn(`⚠️ No price data for ${ing.name}`);
      return resolve();
    }

            const ingredientName = stockItem.ingredient;
            const price = stockItem.price || 0;

            let cost = 0;

            if (ingredientName && isInGrams(ingredientName)) {
  const estimatedGrams = getEstimatedGrams(ingredientName);
  const pricePerGram = price / estimatedGrams;
  cost = pricePerGram * ing.amount;
} else {
              // Fallback: treat price as per unit (like a loaf, tray, etc.)
              cost = price * (ing.amount / 100);
            }

            totalCost += cost;
            breakdown.push({
              ingredient: ing.name,
              qty: ing.amount,
              unit_cost: price.toFixed(2),
              total: cost.toFixed(2),
            });

            resolve();
          }
        );
      });
    });

    Promise.all(promises).then(() => {
      const markups = [2, 2.5, 3, 3.5, 4];
      const suggestedPrices = {};
      markups.forEach(multiplier => {
        suggestedPrices[`${multiplier}x`] = `£${(totalCost * multiplier).toFixed(2)}`;
      });

      res.json({
        meal_id: id,
        total_cost: totalCost.toFixed(2),
        ingredients: breakdown,
        suggested_prices: suggestedPrices
      });
    });
  });
});

app.post('/checklists', authenticateToken, (req, res) => {
    const { name } = req.body;
    const createdBy = req.user.id;
  
    if (!name) {
      return res.status(400).json({ error: "Checklist name is required" });
    }
  
    const query = `INSERT INTO checklists (name, created_by) VALUES (?, ?)`;
    db.run(query, [name, createdBy], function (err) {
      if (err) {
        console.error("❌ Error creating checklist:", err.message);
        return res.status(500).json({ error: "Failed to create checklist" });
      }
  
      res.status(201).json({ id: this.lastID, message: "Checklist created" });
    });
  });  
  
  app.get('/checklists', authenticateToken, (req, res) => {
    const query = `SELECT * FROM checklists ORDER BY id DESC`;
  
    pool.query(query, [], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching checklists:", err.message);
        return res.status(500).json({ error: "Failed to fetch checklists" });
      }
  
      res.status(200).json(rows);
    });
  });   
  
  app.post('/checklists/:id/items', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
    const { description } = req.body;
  
    if (!description) {
      return res.status(400).json({ error: "Task description is required" });
    }
  
    const query = `INSERT INTO checklist_items (checklist_id, description) VALUES (?, ?)`;
    db.run(query, [checklistId, description], function (err) {
      if (err) {
        console.error("❌ Error adding task:", err.message);
        return res.status(500).json({ error: "Failed to add task" });
      }
  
      res.status(201).json({ id: this.lastID, message: "Task added" });
    });
  });

  app.get('/checklists/:id/items', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
  
    const query = `SELECT * FROM checklist_items WHERE checklist_id = ? ORDER BY id ASC`;
    pool.query(query, [checklistId], (err, rows) => {
      if (err) {
        console.error("❌ Error fetching tasks:", err.message);
        return res.status(500).json({ error: "Failed to fetch tasks" });
      }
  
      res.status(200).json(rows);
    });
  });

  app.put('/checklists/items/:itemId/complete', authenticateToken, (req, res) => {
    const itemId = req.params.itemId;
    const completedBy = req.user.id;
  
    const query = `
      UPDATE checklist_items
      SET completed = 1,
          completed_by = ?,
          completed_at = datetime('now')
      WHERE id = ?
    `;
  
    db.run(query, [completedBy, itemId], function (err) {
      if (err) {
        console.error("❌ Error completing task:", err.message);
        return res.status(500).json({ error: "Failed to complete task" });
      }
  
      if (this.changes === 0) {
        return res.status(404).json({ error: "Task not found" });
      }
  
      res.status(200).json({ message: "Task marked as completed" });
    });
  });

  // Delete checklist folder
app.delete('/checklists/:id', authenticateToken, (req, res) => {
    const checklistId = req.params.id;
  
    const deleteItems = `DELETE FROM checklist_items WHERE checklist_id = ?`;
    const deleteFolder = `DELETE FROM checklists WHERE id = ?`;
  
    db.run(deleteItems, [checklistId], (err) => {
      if (err) {
        console.error("❌ Error deleting checklist items:", err.message);
        return res.status(500).json({ error: "Failed to delete checklist items" });
      }
  
      db.run(deleteFolder, [checklistId], (err2) => {
        if (err2) {
          console.error("❌ Error deleting checklist:", err2.message);
          return res.status(500).json({ error: "Failed to delete checklist" });
        }
  
        res.status(200).json({ message: "Checklist deleted successfully" });
      });
    });
  });
  
// server.js or routes/appliances.js
app.post('/appliances', authenticateToken, (req, res) => {
    const { type, name, storage_number, supplier, notes } = req.body;
    const created_by = req.user.id; // This now works because of the middleware
  
    db.run(
      `INSERT INTO appliances (type, name, storage_number, supplier, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [type, name, storage_number, supplier, notes, created_by],
      function (err) {
        if (err) {
          console.error('Error inserting appliance:', err.message);
          return res.status(500).json({ error: 'Database error.' });
        }
        res.json({ id: this.lastID });
      }
    );
  });    
  
  app.get('/appliances', (req, res) => {
    pool.query(`SELECT * FROM appliances`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  });
  
// In your backend server.js or routes file
app.post('/appliance-checks', (req, res) => {
  const { appliance_id, temperature, shift, staff_name } = req.body;
  const time_recorded = new Date().toISOString();

  const query = `
    INSERT INTO appliance_checks (appliance_id, temperature, shift, time_recorded, staff_name)
    VALUES (?, ?, ?, ?, ?)
  `;
  db.run(query, [appliance_id, temperature, shift, time_recorded, staff_name], function (err) {
    if (err) {
      console.error('❌ Insert failed:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ id: this.lastID });
  });
});
  
app.get('/appliance-checks', (req, res) => {
  const query = `
    SELECT ac.*, a.name AS appliance_name
    FROM appliance_checks ac
    LEFT JOIN appliances a ON ac.appliance_id = a.id
    ORDER BY time_recorded DESC
  `;
  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Failed to fetch appliance checks:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(rows);
  });
}); 
   
app.post('/supplier-prices', (req, res) => {
  const { ingredient, supplier_name, price } = req.body;

  const query = `
    INSERT INTO supplier_prices (ingredient, supplier_name, price)
    VALUES (?, ?, ?)
  `;

  db.run(query, [ingredient, supplier_name, price], function (err) {
    if (err) {
      console.error('❌ Error saving supplier price:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
    res.json({ message: '✅ Supplier price saved', id: this.lastID });
  });
});

app.get('/supplier-prices/cheapest/:ingredient', (req, res) => {
  const ingredient = req.params.ingredient;

  const query = `
    SELECT supplier_name, price
    FROM supplier_prices
    WHERE LOWER(ingredient) = LOWER(?)
    ORDER BY price ASC
    LIMIT 1
  `;

  db.get(query, [ingredient], (err, row) => {
    if (err) {
      console.error('❌ Error fetching cheapest supplier:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!row) {
      return res.status(404).json({ message: 'No supplier data found for this ingredient' });
    }

    res.json({
      ingredient,
      cheapest_supplier: row.supplier_name,
      price: row.price
    });
  });
});

// Save current grouped order to history
app.post('/ordering-history', (req, res) => {
  const { groupedOrders } = req.body;

  if (!groupedOrders || typeof groupedOrders !== 'object') {
    return res.status(400).json({ error: "Invalid data" });
  }

  const timestamp = new Date().toISOString();
  const query = `INSERT INTO ordering_history (supplier, ingredient, quantity, price, saved_at)
                 VALUES (?, ?, ?, ?, ?)`;

  const db = new sqlite3.Database('./database.db');
  const stmt = db.prepare(query);

  try {
    for (const supplier in groupedOrders) {
      const items = groupedOrders[supplier].items;
      items.forEach(item => {
        stmt.run(supplier, item.ingredient, item.order_amount, item.price || 0, timestamp);
      });
    }
    stmt.finalize();
    db.close();
    res.json({ success: true, message: "Order history saved!" });
  } catch (err) {
    console.error("❌ Failed to save order history:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/stock/order-list", async (req, res) => {
  try {
    const defaultMin = req.query.min ? parseInt(req.query.min) : 10;

    const result = await new Promise((resolve, reject) => {
      pool.query(
        `
        SELECT s.*, 
               IFNULL(SUM(sp.price), 0) as avg_price
        FROM stock s
        LEFT JOIN supplier_prices sp ON LOWER(TRIM(sp.ingredient)) = LOWER(TRIM(s.ingredient))
        WHERE s.portions_left <= s.minimum_level OR s.portions_left <= ?
        GROUP BY s.ingredient
        `,
        [defaultMin],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    res.json({ orderList: result }); // ✅ important: wrap inside an object
  } catch (error) {
    console.error("Error getting order list:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/suppliers', (req, res) => {
  const { name, website, phone, contact_name, delivery_days } = req.body;

  const query = `
    INSERT INTO suppliers (name, website, phone, contact_name, delivery_days)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(query, [name, website, phone, contact_name, delivery_days], function (err) {
    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to add supplier' });
    } else {
      res.status(201).json({ message: 'Supplier added', supplierId: this.lastID });
    }
  });
});

app.get('/supplier-prices/all/:ingredient', (req, res) => {
  const rawIngredient = req.params.ingredient;
  const ingredient = rawIngredient.trim().toLowerCase().replace(/[\[\]]/g, '');

  const query = `
    SELECT s.ingredient, s.delivery_days, sp.price AS price
    FROM supplier_prices sp
JOIN suppliers s ON LOWER(TRIM(sp.supplier_name)) = LOWER(TRIM(s.name))
    WHERE LOWER(TRIM(sp.ingredient)) = LOWER(TRIM(?))
  `;

  pool.query(query, [ingredient], (err, rows) => {
    console.log(`🧪 Ingredient Query: ${ingredient}`);
    console.log(`📦 Matched rows:`, rows);

    if (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch supplier prices' });
    } else {
      res.json(rows);
    }
  });
});

app.get('/smart-order', async (req, res) => {
  try {

    const ingredientsToOrder = await db.allAsync(`
      SELECT ingredient FROM stock WHERE quantity < minimum_level
    `);
    
    if (!ingredientsToOrder || ingredientsToOrder.length === 0) {
      return res.json({});
    }
    
    const supplierOrders = {};
    
    for (const item of ingredientsToOrder) {
      const cheapest = await db.getAsync(`
       SELECT ingredient, price, supplier_name
       FROM supplier_prices
       WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
       ORDER BY price ASC
       LIMIT 1 
      `, [item.ingredient]);
    
      if (cheapest) {
        if (!supplierOrders[cheapest.supplier_name]) {
          supplierOrders[cheapest.supplier_name] = [];
        }
        supplierOrders[cheapest.supplier_name].push({
          ingredient: cheapest.ingredient,
          price: cheapest.price
        });         
      }
    }
    
    res.json(supplierOrders);           
  } catch (err) {
    console.error(err);
    res.status(500).send('Error building smart order list');
  }
});

app.post('/reports', async (req, res) => {
  const { order_id, item_name, reason, reported_by, quantity, redo } = req.body;

  try {
    await db.runAsync(`
      INSERT INTO reports (order_id, item_name, reason, reported_by, quantity)
      VALUES (?, ?, ?, ?, ?)
    `, [order_id, item_name, reason, reported_by, quantity]);

    if (redo) {
      // Decrease stock again for redo
      await db.runAsync(`
        UPDATE stock
        SET quantity = quantity - ?
        WHERE LOWER(TRIM(ingredient)) = LOWER(TRIM(?))
      `, [quantity, item_name]);
    }

    res.json({ message: 'Report logged successfully' });
  } catch (err) {
    console.error('❌ Failed to log report', err);
    res.status(500).send('Error logging report');
  }
});

app.post('/prepped-items', async (req, res) => {
  const { name, ingredients, hold_temperature, shelf_life_hours } = req.body;

  try {
    await db.runAsync(
      `INSERT INTO prepped_items (name, quantity, ingredients, hold_temperature, shelf_life_hours)
       VALUES (?, 0, ?, ?, ?)`,
      [name, JSON.stringify(ingredients), hold_temperature, shelf_life_hours]
    );

    res.json({ message: '✅ Prepped item added' });
  } catch (err) {
    console.error('❌ Failed to add prepped item:', err);
    res.status(500).send('Error adding prepped item');
  }
});

app.post('/prepped-items/prepare', async (req, res) => {
  const { name, batchQuantity } = req.body;

  if (!name || !batchQuantity) {
    return res.status(400).json({ error: 'Name and batch quantity are required.' });
  }

  try {
    // Get prepped item info
    const item = await db.getAsync(`SELECT * FROM prepped_items WHERE LOWER(name) = LOWER(?)`, [name]);

    if (!item) {
      return res.status(404).json({ error: 'Prepped item not found.' });
    }

    // Parse ingredients JSON
    const ingredients = JSON.parse(item.ingredients || '[]');

    // Deduct ingredients from stock
    for (const ing of ingredients) {
      const totalToDeduct = ing.amount * batchQuantity;

      const stockItem = await db.getAsync(`SELECT quantity FROM stock WHERE LOWER(ingredient) = LOWER(?)`, [ing.ingredient]);

      if (!stockItem || stockItem.quantity < totalToDeduct) {
        return res.status(400).json({ error: `Not enough stock for ingredient: ${ing.ingredient}` });
      }

      await db.runAsync(
        `UPDATE stock SET quantity = quantity - ? WHERE LOWER(ingredient) = LOWER(?)`,
        [totalToDeduct, ing.ingredient]
      );
    }

    // Calculate expiry date (now + shelf_life_hours)
    const expiryDate = new Date(Date.now() + (item.shelf_life_hours * 60 * 60 * 1000)).toISOString();

    // Update prepped item quantity & expiry_date
    await db.runAsync(
      `UPDATE prepped_items SET quantity = quantity + ?, expiry_date = ?, created_at = CURRENT_TIMESTAMP WHERE LOWER(name) = LOWER(?)`,
      [batchQuantity, expiryDate, name]
    );

    console.log(`✅ Prepared ${batchQuantity} ${item.unit || 'kg'} of ${name}, expires on ${expiryDate}`);

    res.json({ success: true, message: `Prepared ${batchQuantity} ${item.unit || 'kg'} of ${name}` });

  } catch (err) {
    console.error("❌ Failed to prepare batch:", err);
    res.status(500).send('Internal server error');
  }
});

app.get('/prepped-items', async (req, res) => {
  try {
    const items = await db.allAsync(`SELECT * FROM prepped_items`);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to fetch prepped items');
  }
});

app.get('/stock/search', async (req, res) => {
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const results = await db.allAsync(`
      SELECT ingredient FROM stock
      WHERE LOWER(ingredient) LIKE LOWER(?) LIMIT 10
    `, [`%${q.trim()}%`]);

    res.json(results.map(r => r.ingredient));
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Failed to search ingredients');
  }
});

app.get('/prepped-items/today-prep', async (req, res) => {
  try {
    const items = await db.allAsync(`
      SELECT id, name, ingredients, quantity, unit
      FROM prepped_items
    `);

    console.log('Fetched prepped items:', items);

    res.json(items);
  } catch (err) {
    console.error('❌ Failed to fetch prepped items', err);
    res.status(500).send('Error loading prepped items');
  }
});

app.get('/prepped-items/daily-checklist', async (req, res) => {
  try {
    // 1. Get today's orders
    const today = new Date().toISOString().split('T')[0];
    const orders = await db.allAsync(`
      SELECT meal_name, SUM(quantity) as total_quantity
      FROM orders
      WHERE DATE(created_at) = ?
      GROUP BY meal_name
    `, [today]);

    if (!orders.length) {
      return res.json({ message: '✅ No orders today.', checklist: [] });
    }

    // 2. Get meal-prepped-ingredient relations
    const relations = await db.allAsync(`SELECT * FROM meal_prepped_ingredients`);

    // 3. Get current prepped stock
    const preppedStock = await db.allAsync(`SELECT name, quantity, unit FROM prepped_items`);

    const checklist = [];

    // 4. Calculate needed quantities
    for (const relation of relations) {
      const order = orders.find(o => o.meal_name.toLowerCase() === relation.meal_name.toLowerCase());
      if (!order) continue;

      const needed = relation.amount_per_meal * order.total_quantity;

      const stockItem = preppedStock.find(p => p.name.toLowerCase() === relation.prepped_item_name.toLowerCase());
      const currentStock = stockItem ? stockItem.quantity : 0;

      if (currentStock < needed) {
        checklist.push({
          prepped_item: relation.prepped_item_name,
          needed,
          in_stock: currentStock,
          unit: stockItem?.unit || 'kg',
          to_prepare: needed - currentStock
        });
      }
    }

    res.json({ checklist });

  } catch (err) {
    console.error('❌ Error building daily checklist:', err);
    res.status(500).send('Server error');
  }
});

// Delete prepped item by ID
app.delete('/prepped-items/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await db.run('DELETE FROM prepped_items WHERE id = ?', id);
    res.json({ message: 'Prepped item deleted successfully' });
  } catch (err) {
    console.error('❌ Failed to delete prepped item:', err);
    res.status(500).send('Error deleting prepped item');
  }
});

// GET /tables/:table/total
app.get("/tables/:table/total", async (req, res) => {
  try {
    const tableName = req.params.table;

    const result = await db.get(
      `SELECT SUM(price) as total FROM orders WHERE table_number = ? AND paid = 0`,
      [tableName]
    );

    res.json({ total: result?.total || 0 });
  } catch (error) {
    console.error("Error getting table total:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ Unified Drinks using Stock Table
app.post('/drinks', authenticateToken, (req, res) => {
  const { ingredient, quantity, price, allergens = '', supplier_id = null, category = 'General' } = req.body;

  if (!ingredient || quantity === undefined || price === undefined) {
    return res.status(400).json({ error: 'Missing required drink fields.' });
  }

  const { type = 'drink' } = req.body; // 👈 fallback default
  const insert = `INSERT INTO stock (ingredient, quantity, price, allergens, supplier_id, category, type)
                VALUES (?, ?, ?, ?, ?, ?, ?)`;

  db.run(insert, [ingredient, quantity, price, allergens, supplier_id, category, type], function (err) {
    if (err) {
      console.error('❌ Error saving drink:', err.message);
      return res.status(500).json({ error: 'Failed to save drink.' });
    }
    res.status(201).json({ id: this.lastID, message: '✅ Drink saved in unified stock.' });
  });
});

app.get('/drinks', (req, res) => {
  const query = `SELECT * FROM stock WHERE type = 'drink'`;

  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching drinks:', err.message);
      return res.status(500).json({ error: 'Failed to fetch drinks' });
    }

    const drinks = rows.map(item => ({
      ...item,
      name: item.name || item.ingredient // 🧠 fallback
    }));

    res.json(drinks);
  });
});

app.delete('/drinks/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM stock WHERE id = ? AND type = 'drink'`, [id], function (err) {
    if (err) {
      console.error('❌ Error deleting drink:', err.message);
      return res.status(500).json({ error: 'Failed to delete drink.' });
    }
    res.json({ message: '✅ Drink deleted from unified stock.' });
  });
});

// ✅ Create Booking with Conflict Check
app.post('/bookings', authenticateToken, (req, res) => {
  const { customer_name, phone, number_of_people, table_number, booking_time } = req.body;

  if (!customer_name || !phone || !number_of_people || !table_number || !booking_time) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const bookingStart = new Date(booking_time);
  const bookingEnd = new Date(bookingStart.getTime() + 2 * 60 * 60 * 1000); // 2 hours slot

  const query = `
    SELECT * FROM bookings 
    WHERE table_number = ? 
    AND datetime(booking_time) < datetime(?) 
    AND datetime(booking_time, '+2 hours') > datetime(?)
  `;

  pool.query(query, [table_number, bookingEnd.toISOString(), bookingStart.toISOString()], (err, rows) => {
    if (err) {
      console.error('❌ Error checking conflicts:', err.message);
      return res.status(500).json({ error: 'Internal server error.' });
    }

    if (rows.length > 0) {
      return res.status(409).json({ 
        conflict: true,
        message: `❌ Table ${table_number} is already booked around this time.`,
        conflicts: rows 
      });
    }

    // If no conflict, insert
    const insert = `
      INSERT INTO bookings (customer_name, phone, number_of_people, table_number, booking_time, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `;

    db.run(insert, [customer_name, phone, number_of_people, table_number, booking_time], function (err) {
      if (err) {
        console.error('❌ Error saving booking:', err.message);
        return res.status(500).json({ error: 'Failed to save booking.' });
      }
      res.status(201).json({ id: this.lastID, message: '✅ Booking saved.' });
    });
  });
});

// 📅 Get All Bookings (sorted)
app.get('/bookings', authenticateToken, (req, res) => {
  pool.query(`
    SELECT * FROM bookings 
    ORDER BY datetime(booking_time) ASC
  `, (err, rows) => {
    if (err) {
      console.error("❌ Failed to fetch bookings:", err.message);
      return res.status(500).json({ error: "Failed to fetch bookings." });
    }
    res.json(rows);
  });
});

// ❌ Delete a booking
app.delete('/bookings/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM bookings WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error("❌ Failed to delete booking:", err.message);
      return res.status(500).json({ error: "Failed to delete booking." });
    }
    res.json({ message: '🗑️ Booking deleted successfully.' });
  });
});

// ✅ Mark Booking as Arrived
app.put('/bookings/arrived/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.run(`UPDATE bookings SET status = 'arrived' WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error('❌ Error updating booking status:', err.message);
      return res.status(500).json({ error: 'Failed to mark as arrived.' });
    }
    res.json({ message: '✅ Booking marked as arrived.' });
  });
});

// ✅ Cancel Booking (Delete)
app.delete('/bookings/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM bookings WHERE id = ?`, [id], function (err) {
    if (err) {
      console.error('❌ Error deleting booking:', err.message);
      return res.status(500).json({ error: 'Failed to delete booking.' });
    }
    res.json({ message: '✅ Booking cancelled.' });
  });
});

app.get('/bookings/conflicts', authenticateToken, (req, res) => {
  const booking_time = req.query.time;

  if (!booking_time) {
    return res.status(400).json({ error: "Missing booking time." });
  }

  const query = `
    SELECT DISTINCT table_number 
    FROM bookings 
    WHERE datetime(booking_time) BETWEEN datetime(?) AND datetime(?, '+2 hours')
  `;

  pool.query(query, [booking_time, booking_time], (err, rows) => {
    if (err) {
      console.error("❌ Error checking conflicts:", err.message);
      return res.status(500).json({ error: "Failed to check conflicts." });
    }

    const occupiedTables = rows.map(r => r.table_number);
    const allTables = Array.from({ length: 20 }, (_, i) => i + 1); // Change max table count as needed
    const availableTables = allTables.filter(t => !occupiedTables.includes(t));

    res.json({ available_tables: availableTables });
  });
});

app.put('/orders/delivery-status/:batchId', (req, res) => {
  const { batchId } = req.params;
  const { status } = req.body;

  if (!['accepted', 'declined'].includes(status)) {
    return res.status(400).json({ error: 'Invalid delivery status' });
  }

  // If accepted, generate 4-digit code
  const deliveryCode = status === 'accepted' 
    ? Math.floor(1000 + Math.random() * 9000).toString()
    : null;

  const query = `
    UPDATE order_batches 
    SET delivery_status = ?, delivery_code = ?
    WHERE id = ?
  `;

  db.run(query, [status, deliveryCode, batchId], function (err) {
    if (err) {
      console.error("❌ Error updating delivery status:", err.message);
      return res.status(500).json({ error: 'Failed to update delivery status' });
    }

    res.json({
      success: true,
      message: '✅ Delivery status updated',
      delivery_code: deliveryCode
    });
  });
});

// Get pause status
app.get('/kitchen/pause-status', (req, res) => {
  db.get('SELECT is_paused FROM kitchen_settings WHERE id = 1', (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to get pause status' });
    res.json({ is_paused: row?.is_paused === 1 });
  });
});

// Toggle pause status
app.put('/kitchen/pause-status', (req, res) => {
  const { is_paused } = req.body;
  db.run('UPDATE kitchen_settings SET is_paused = ? WHERE id = 1', [is_paused ? 1 : 0], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to update pause status' });
    res.json({ success: true });
  });
});

// Estimated delay: read from kitchen_settings (not kitchen_status)
app.get('/kitchen/estimated-delay', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM orders WHERE order_type = "delivery"', (err, row) => {
    if (err) return res.status(500).json({ error: 'Failed to get delay estimate' });

    db.get('SELECT is_paused FROM kitchen_settings WHERE id = 1', (err2, row2) => {
      if (err2) return res.status(500).json({ error: 'Failed to get pause status' });
      const isPaused = row2?.is_paused === 1;
      const count = row?.count || 0;
      const delay = isPaused ? 999 : count >= 20 ? 45 : count >= 15 ? 35 : count >= 10 ? 25 : count >= 5 ? 15 : 10;
      res.json({ delay });
    });
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

// 🧠 Estimate delay based on pending orders + pause status
function estimateDelay(pendingOrdersCount, isPaused) {
  if (isPaused) return 999; // "Paused" state, reject or delay all
  if (pendingOrdersCount >= 20) return 45;
  if (pendingOrdersCount >= 15) return 35;
  if (pendingOrdersCount >= 10) return 25;
  if (pendingOrdersCount >= 5) return 15;
  return 10; // Light load
}

app.get('/stock/available-for-delivery', (req, res) => {
  const query = `
    SELECT id, ingredient AS name, quantity, unit, type 
    FROM stock 
    WHERE quantity > 0 
    AND type IN ('ingredient', 'drink', 'dessert')
  `;

  pool.query(query, [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching stock for delivery:', err.message);
      return res.status(500).json({ error: 'Failed to fetch stock for delivery.' });
    }

    // Only return cleaned names + available quantity
    const deliveryStock = rows.map(item => ({
      name: item.name,
      available_quantity: item.quantity,
      unit: item.unit || 'unit',
      type: item.type,
    }));

    res.json(deliveryStock);
  });
});

app.get('/meals/:id/is-available', (req, res) => {
  const { id } = req.params;

  const mealQuery = `
    SELECT mi.ingredient, mi.quantity, s.quantity AS stock_quantity
    FROM meal_ingredients mi
    LEFT JOIN stock s ON LOWER(TRIM(s.ingredient)) = LOWER(TRIM(mi.ingredient))
    WHERE mi.meal_id = ?
  `;

  pool.query(mealQuery, [id], (err, rows) => {
    if (err) {
      console.error('❌ Error checking meal availability:', err.message);
      return res.status(500).json({ error: 'Failed to check meal availability.' });
    }

    const isAvailable = rows.every(row => row.stock_quantity !== null && row.stock_quantity >= row.quantity);
    res.json({ available: isAvailable });
  });
});

app.get('/meals/available-for-delivery', async (req, res) => {
  try {
    db.get('SELECT is_paused FROM kitchen_settings LIMIT 1', (err, row) => {
      if (err) return res.status(500).json({ error: 'Failed to check pause status' });
      if (row?.is_paused) return res.json([]); // kitchen paused → no meals available

      pool.query('SELECT * FROM meals WHERE paused = 0', [], async (err, meals) => {
        if (err) return res.status(500).json({ error: 'Failed to fetch meals' });

        const availableMeals = [];

        for (const meal of meals) {
          const mealId = meal.id;
          const ingredients = await new Promise((resolve, reject) => {
            pool.query(`
              SELECT mi.ingredient, mi.quantity, s.quantity AS stock_quantity
              FROM meal_ingredients mi
              LEFT JOIN stock s ON LOWER(TRIM(s.ingredient)) = LOWER(TRIM(mi.ingredient))
              WHERE mi.meal_id = ?
            `, [mealId], (err, rows) => {
              if (err) reject(err);
              else resolve(rows);
            });
          });

          const isAvailable = ingredients.every(row => row.stock_quantity !== null && row.stock_quantity >= row.quantity);
          if (isAvailable) availableMeals.push(meal);
        }

        res.json(availableMeals);
      });
    });
  } catch (e) {
    console.error('❌ Error checking available delivery meals:', e);
    res.status(500).json({ error: 'Unexpected error' });
  }
});

app.post('/orders/delivery', async (req, res) => {
  const { customer_name, items, platform } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items in order.' });
  }

  const batch_id = `DEL-${Date.now()}`;
  const timestamp = new Date().toISOString();

  try {
    const row = await db.getAsync('SELECT is_paused FROM kitchen_settings WHERE id = 1');
if (row?.is_paused === 1) {
  return res.status(403).json({ error: 'Kitchen is paused. Cannot accept delivery orders now.' });
}

    for (const item of items) {
      const { meal_name, quantity, total_price, special_requests } = item;

      await db.run(
        `INSERT INTO orders 
         (batch_id, table_number, meal_name, quantity, total_price, paid, created_at, category, order_type, special_requests)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          batch_id,
          'Delivery',
          meal_name,
          quantity,
          total_price,
          1,
          timestamp,
          'meals',
          'delivery',
          special_requests || ''
        ]
      );
    }

    res.json({ success: true, message: '✅ Delivery order submitted', batch_id });
  } catch (err) {
    console.error('❌ Error submitting delivery order:', err.message);
    res.status(500).json({ error: 'Failed to submit delivery order' });
  }
});

// ✅ correct order that matches the frontend
app.get('/meals/:name/ingredients', (req, res) => {
  const name = req.params.name.trim();

  db.get(
    'SELECT id FROM meals WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
    [name],
    (err, row) => {
      if (err || !row) {
        console.error('❌ Meal not found for ingredients:', name);
        return res.status(404).json({ error: 'Meal not found' });
      }

      pool.query(
        'SELECT ingredient AS ingredient_name, quantity FROM meal_ingredients WHERE meal_id = ?',
        [row.id],
        (err, ingredients) => {
          if (err) {
            console.error('❌ Failed to fetch meal ingredients:', err);
            return res.status(500).json({ error: 'Could not fetch ingredients' });
          }

          res.json({ ingredients });
        }
      );
    }
  );
});

// Save a full menu layout
app.post('/menus/save', (req, res) => {
  const { title, sections } = req.body;

  // Example: sections = [{ name: "Starters", items: [{id, name, price}] }, ...]
  db.run(`INSERT INTO menus (title, json_data) VALUES (?, ?)`,
    [title, JSON.stringify(sections)],
    function (err) {
      if (err) {
        console.error("❌ Failed to save menu:", err);
        return res.status(500).json({ error: "Could not save menu" });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.get('/drinks/restock-list', async (req, res) => {
  try {
    const drinks = await new Promise((resolve, reject) => {
      pool.query(`SELECT ingredient AS name, quantity FROM stock WHERE type = 'drink'`, [], (err, rows) => {
        if (err) {
          return reject(err);
        }
        resolve(rows);
      });
    });

    const lowStock = drinks.filter(drink => drink.quantity < 5);
    res.json(lowStock);
  } catch (err) {
    console.error('❌ Failed to fetch restock list:', err);
    res.status(500).json({ error: 'Failed to fetch restock list' });
  }
});

app.get('/drinks/restock-orders', authenticateToken, async (req, res) => {
  try {
    const orders = await pool.query("SELECT * FROM restock_orders WHERE type = 'drink' ORDER BY created_at DESC");
    res.json(orders);
  } catch (error) {
    console.error("❌ Failed to fetch restock orders:", error);
    res.status(500).json({ error: "Failed to fetch restock orders" });
  }
});

// --------------------- TABLE MAP ROUTES ---------------------
app.get('/table-map', (req, res) => {
  pool.query('SELECT * FROM table_map', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch table map' });
    res.json(rows);
  });
});

app.post('/table-map', (req, res) => {
  const { id, name, seats, shape, x, y, status, zone } = req.body;
  if (id) {
    db.run(
      `UPDATE table_map SET name = ?, seats = ?, shape = ?, x = ?, y = ?, status = ?, zone = ? WHERE id = ?`,
      [name, seats, shape, x, y, status, zone, id],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to update table' });
        res.json({ message: 'Updated', id });
      }
    );
  } else {
    db.run(
      `INSERT INTO table_map (name, seats, shape, x, y, status, zone) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, seats, shape, x, y, status || 'free', zone || 'Main'],
      function (err) {
        if (err) return res.status(500).json({ error: 'Failed to add table' });
        res.json({ message: 'Added', id: this.lastID });
      }
    );
  }
});

app.delete('/table-map/:id', (req, res) => {
  const id = req.params.id;
  db.run(`DELETE FROM table_map WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: 'Failed to delete table' });
    res.json({ message: 'Deleted' });
  });
});

app.put('/tables/:id', (req, res) => {
  const { x, y } = req.body;
  const id = req.params.id;

  db.run(`UPDATE tables SET x = ?, y = ? WHERE id = ?`, [x, y, id], function (err) {
    if (err) {
      return res.status(500).json({ error: 'Failed to update position' });
    }
    res.json({ success: true });
  });
});

// Update table status (e.g., to 'free' or 'occupied')
app.post('/tables/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const sql = `UPDATE tables SET status = ? WHERE id = ?`;
  db.run(sql, [status, id], function (err) {
    if (err) {
      console.error('❌ Error updating table status:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ success: true });
  });
});

// Route: POST /nova/save-trained-items
app.post('/nova/save-trained-items', (req, res) => {
  const newItems = req.body.items;

  // Read existing knowledge
  let existing = [];
  try {
    const raw = fs.readFileSync('nova_knowledge.json');
    existing = JSON.parse(raw);
  } catch (err) {
    console.warn("No existing knowledge, starting fresh.");
  }

  // Combine and remove duplicates
  const combined = [...existing, ...newItems];
  const unique = Array.from(
    new Map(combined.map(item => [item.raw_name.toLowerCase(), item])).values()
  );

  // Save to file
  fs.writeFileSync('nova_knowledge.json', JSON.stringify(unique, null, 2));
  res.send({ message: '✅ Nova knowledge saved' });
});

app.post('/orders/split-pay', (req, res) => {
  const { itemIds } = req.body;

  if (!itemIds || !itemIds.length) {
    return res.status(400).json({ error: "No items selected for split payment" });
  }

  const placeholders = itemIds.map(() => '?').join(',');
  const sql = `UPDATE orders SET paid = 1 WHERE id IN (${placeholders})`;

  db.run(sql, itemIds, function (err) {
    if (err) {
      console.error("❌ Error in split payment:", err.message);
      return res.status(500).json({ error: err.message });
    }
    console.log(`✅ ${this.changes} items marked as paid`);
    res.json({ success: true, updated: this.changes });
  });
});

app.post('/orders/split-by-people', (req, res) => {
  const { table_number, people } = req.body;

  if (!table_number || !people || isNaN(people) || people < 1) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  db.get(`
    SELECT SUM(price) as total FROM orders
    WHERE table_number = ? AND paid = 0
  `, [table_number], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });

    const total = row?.total || 0;
    const share = parseFloat((total / people).toFixed(2));
    return res.json({ total, people, share });
  });
});

app.post('/orders/pay-share', (req, res) => {
  const { table_number, amount } = req.body;

  if (!table_number || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  pool.query(`
    SELECT * FROM orders
    WHERE table_number = ? AND paid = 0
    ORDER BY created_at ASC
  `, [table_number], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    let total = 0;
    const itemsToPay = [];

    for (const row of rows) {
      if (total + row.price <= amount) {
        total += row.price;
        itemsToPay.push(row.id);
      }
    }

    if (itemsToPay.length === 0) {
      return res.status(200).json({ paid_total: 0, items_paid: [] });
    }

    const placeholders = itemsToPay.map(() => '?').join(',');
    db.run(`
      UPDATE orders SET paid = 1 WHERE id IN (${placeholders})
    `, itemsToPay, function (updateErr) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });
      return res.json({ paid_total: total, items_paid: itemsToPay });
    });
  });
});

app.delete('/categories/:id', async (req, res) => {
  const { id } = req.params;

  try {
    await db.run('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ success: true, message: 'Category deleted' });
  } catch (err) {
    console.error('❌ Failed to delete category:', err.message);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// GET /search?q=latte
app.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const like = `%${q}%`;

  const sql = `
  SELECT m.id AS item_id, m.name, COALESCE(m.category, '') AS subcategory,
         'meals' AS type
  FROM meals m
  WHERE m.name LIKE ? OR (m.category LIKE ?)

  UNION ALL

  SELECT s.id AS item_id, COALESCE(s.ingredient, s.name) AS name,
         COALESCE(s.category,'') AS subcategory,
         CASE WHEN s.type='drink' THEN 'drinks' ELSE 'desserts' END AS type
  FROM stock s
  WHERE (s.type IN ('drink','dessert'))
    AND (COALESCE(s.ingredient, s.name) LIKE ? OR COALESCE(s.category,'') LIKE ?)

  ORDER BY name ASC
  `;

  pool.query(sql, [like, like, like, like], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Search failed' });
    res.json(rows);
  });
});

// Test endpoint
app.get('/', (req, res) => {
    res.send('Backend is working!');
});

// Start the server
app.listen(5000, '0.0.0.0', () => {
    console.log('✅ Server running on http://192.168.1.212:5000');
  });  
