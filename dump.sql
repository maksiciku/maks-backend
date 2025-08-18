PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE pos_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_number TEXT NOT NULL,
            meal_name TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            total_price REAL NOT NULL,
            order_status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        , paid INTEGER DEFAULT 0, options TEXT, note TEXT);
CREATE TABLE tables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'free',
        active_order_id INTEGER
      , y REAL DEFAULT 0, x REAL DEFAULT 0);
INSERT INTO tables VALUES(1,'Table 1','occupied',NULL,0.0,0.0);
INSERT INTO tables VALUES(3,'Table 2','occupied',NULL,0.0,0.0);
INSERT INTO tables VALUES(4,'Table 3','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(5,'Table 4','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(6,'Table 5','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(7,'Table 6','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(8,'Table 7','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(9,'Table 8','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(10,'Table 9','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(11,'Table 10','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(12,'Table 11','free',NULL,0.0,0.0);
INSERT INTO tables VALUES(13,'Table 12','free',NULL,0.0,0.0);
CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    );
INSERT INTO users VALUES(2,'admin','$2b$10$4uLkPeTQwwxAC8vHTFP50O4CJVyBuwgv89IwSeGd6TFiAzWXt37GG','admin');
CREATE TABLE checklists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_by INTEGER
      );
INSERT INTO checklists VALUES(2,'Front OF The House',2);
INSERT INTO checklists VALUES(3,'Kitchen',2);
INSERT INTO checklists VALUES(4,'PotWash',2);
CREATE TABLE checklist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        checklist_id INTEGER NOT NULL,
        description TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        completed_by INTEGER,
        completed_at TEXT,
        FOREIGN KEY (checklist_id) REFERENCES checklists(id)
      );
CREATE TABLE appliances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        storage_number TEXT,
        supplier TEXT,
        notes TEXT,
        created_by INTEGER
      );
INSERT INTO appliances VALUES(1,'Fridge','1','1','','',2);
INSERT INTO appliances VALUES(2,'Freezer','Chest Frezeer outside','3','Zampa','only fish',2);
CREATE TABLE appliance_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appliance_id INTEGER NOT NULL,
        temperature TEXT NOT NULL,
        shift TEXT NOT NULL,
        time_recorded TEXT NOT NULL
      , staff_name TEXT);
CREATE TABLE suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  phone TEXT,
  contact_name TEXT,
  delivery_days TEXT
, contact TEXT, email TEXT, reliability_score REAL DEFAULT 5.0);
INSERT INTO suppliers VALUES(1,'Booker',NULL,NULL,NULL,NULL,NULL,NULL,5.0);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT DEFAULT 'meal'  -- can be 'meal', 'drink', 'dessert', or custom
, icon TEXT, sort_order INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
INSERT INTO categories VALUES(1,'meals','meals','🍽️',0,1);
INSERT INTO categories VALUES(4,'Breakfast','meals','🍽️',0,1);
INSERT INTO categories VALUES(7,'Lunch','meals','🍽️',0,1);
INSERT INTO categories VALUES(8,'Dinner','meals','🍽️',0,1);
INSERT INTO categories VALUES(9,'Dessert','desserts','🍽️',0,1);
INSERT INTO categories VALUES(10,'Drinks','drinks','🍽️',0,1);
CREATE TABLE IF NOT EXISTS "supplier_prices" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  price REAL NOT NULL,
  date_added TEXT DEFAULT (datetime('now'))
);
INSERT INTO supplier_prices VALUES(1,'nestle pure life multipack fe','Bookers',2.0,'2025-05-13 14:31:32');
INSERT INTO supplier_prices VALUES(2,'cl tortillas lightly salted 6','TJ Suppliers',1.5,'2025-05-13 14:31:32');
INSERT INTO supplier_prices VALUES(3,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(4,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(5,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(6,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(7,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(8,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(9,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-26 16:21:58');
INSERT INTO supplier_prices VALUES(10,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(11,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(12,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(13,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(14,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(15,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(16,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-26 16:25:10');
INSERT INTO supplier_prices VALUES(17,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(18,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(19,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(20,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(21,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(22,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(23,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-26 16:26:09');
INSERT INTO supplier_prices VALUES(24,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(25,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(26,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(27,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(28,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(29,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(30,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-26 16:33:27');
INSERT INTO supplier_prices VALUES(31,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(32,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(33,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(34,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(35,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(36,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(37,'white bread loaf','Unknown Supplier',2.0,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(38,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(39,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-05-27 21:51:38');
INSERT INTO supplier_prices VALUES(40,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(41,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(42,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(43,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(44,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(45,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(46,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-27 22:00:04');
INSERT INTO supplier_prices VALUES(47,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(48,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(49,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(50,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(51,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(52,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(53,'white bread loaf','Unknown Supplier',2.0,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(54,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(55,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-05-28 20:48:39');
INSERT INTO supplier_prices VALUES(56,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(57,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(58,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(59,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(60,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(61,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(62,'white bread loaf','Unknown Supplier',2.0,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(63,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(64,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-05-28 20:49:22');
INSERT INTO supplier_prices VALUES(65,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(66,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(67,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(68,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(69,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(70,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(71,'white bread loaf','Unknown Supplier',2.0,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(72,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(73,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-05-28 21:16:08');
INSERT INTO supplier_prices VALUES(74,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(75,'plain flour 15kg','Unknown Supplier',4.0,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(76,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(77,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(78,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(79,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(80,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-05-29 21:18:13');
INSERT INTO supplier_prices VALUES(81,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(82,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(83,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(84,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(85,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(86,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(87,'white bread loaf','Unknown Supplier',2.0,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(88,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(89,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-01 22:26:40');
INSERT INTO supplier_prices VALUES(90,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(91,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(92,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(93,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(94,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(95,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(96,'white bread loaf','Unknown Supplier',2.0,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(97,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(98,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-01 22:37:37');
INSERT INTO supplier_prices VALUES(99,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(100,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(101,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(102,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(103,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(104,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(105,'white bread loaf','Unknown Supplier',2.0,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(106,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(107,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-09 09:28:22');
INSERT INTO supplier_prices VALUES(108,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(109,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(110,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(111,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(112,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(113,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(114,'white bread loaf','Unknown Supplier',2.0,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(115,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(116,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-09 09:29:49');
INSERT INTO supplier_prices VALUES(117,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(118,'plain flour 15kg','Unknown Supplier',4.0,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(119,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(120,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(121,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(122,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(123,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-06-19 08:42:15');
INSERT INTO supplier_prices VALUES(124,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(125,'plain flour 15kg','Unknown Supplier',4.0,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(126,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(127,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(128,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(129,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(130,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-06-19 12:10:15');
INSERT INTO supplier_prices VALUES(131,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(132,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(133,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(134,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(135,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(136,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 13:26:34');
INSERT INTO supplier_prices VALUES(137,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(138,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(139,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(140,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(141,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(142,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 13:28:18');
INSERT INTO supplier_prices VALUES(143,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(144,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(145,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(146,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(147,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(148,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 15:18:33');
INSERT INTO supplier_prices VALUES(149,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(150,'plain flour 15kg','Unknown Supplier',4.0,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(151,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(152,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(153,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(154,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(155,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-06-19 15:35:54');
INSERT INTO supplier_prices VALUES(156,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(157,'plain flour 15kg','Unknown Supplier',4.0,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(158,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(159,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(160,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(161,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(162,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-06-19 15:36:46');
INSERT INTO supplier_prices VALUES(163,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(164,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(165,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(166,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(167,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(168,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(169,'white bread loaf','Unknown Supplier',2.0,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(170,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-19 15:36:57');
INSERT INTO supplier_prices VALUES(171,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-19 15:36:58');
INSERT INTO supplier_prices VALUES(172,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(173,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(174,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(175,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(176,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(177,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 15:38:33');
INSERT INTO supplier_prices VALUES(178,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(179,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(180,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(181,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(182,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(183,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 15:39:09');
INSERT INTO supplier_prices VALUES(184,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(185,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(186,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(187,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(188,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(189,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 15:58:18');
INSERT INTO supplier_prices VALUES(190,'cumberland sausages 25kg','Unknown Supplier',8.75,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(191,'free range eggs tray of 30','Unknown Supplier',3.600000000000000088,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(192,'crushed tomatoes 25kg','Unknown Supplier',2.200000000000000178,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(193,'sliced mushrooms 1kg','Unknown Supplier',3.399999999999999912,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(194,'back bacon unsmoked 2kg','Unknown Supplier',7.990000000000000213,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(195,'frozen hashbrowns 15kg','Unknown Supplier',2.5,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(196,'white bread loaf','Unknown Supplier',2.0,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(197,'brown bread loaf','Unknown Supplier',2.100000000000000088,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(198,'baked beans 26kg catering tin','Unknown Supplier',3.299999999999999823,'2025-06-19 16:00:01');
INSERT INTO supplier_prices VALUES(199,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(200,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(201,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(202,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(203,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(204,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 16:17:51');
INSERT INTO supplier_prices VALUES(205,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(206,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(207,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(208,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(209,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(210,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-19 16:29:44');
INSERT INTO supplier_prices VALUES(211,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(212,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(213,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(214,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(215,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(216,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 15:54:20');
INSERT INTO supplier_prices VALUES(217,'crushed tomatoes 25kg','Unknown Supplier',6.599999999999999645,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(218,'plain flour 15kg','Unknown Supplier',4.0,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(219,'free range eggs tray of 30','Unknown Supplier',3.0,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(220,'baguettes 20 x 18 be','Unknown Supplier',8.800000000000000711,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(221,'carrot cake 12kg','Unknown Supplier',4.990000000000000213,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(222,'chocolate fudge cake 12ptn','Unknown Supplier',11.0,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(223,'vanilla ice cream 4l','Unknown Supplier',3.600000000000000088,'2025-06-20 15:54:43');
INSERT INTO supplier_prices VALUES(224,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(225,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(226,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(227,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(228,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(229,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 16:00:16');
INSERT INTO supplier_prices VALUES(230,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(231,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(232,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(233,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(234,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(235,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 16:05:06');
INSERT INTO supplier_prices VALUES(236,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(237,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(238,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(239,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(240,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(241,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 16:05:35');
INSERT INTO supplier_prices VALUES(242,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(243,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(244,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(245,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(246,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(247,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 16:25:42');
INSERT INTO supplier_prices VALUES(248,'cocacola 24x330ml 2 1099','Unknown Supplier',21.98000000000000042,'2025-06-20 16:26:06');
INSERT INTO supplier_prices VALUES(249,'red bull energy drink 11 1149','Unknown Supplier',4.200000000000000177,'2025-06-20 16:26:06');
INSERT INTO supplier_prices VALUES(250,'still water 12x50ml','Unknown Supplier',14.90000000000000035,'2025-06-20 16:26:06');
INSERT INTO supplier_prices VALUES(251,'appletiser sparkling 2','Unknown Supplier',15.25,'2025-06-20 16:26:06');
INSERT INTO supplier_prices VALUES(252,'fevertree tonic 11 1525','Unknown Supplier',15.25,'2025-06-20 16:26:06');
INSERT INTO supplier_prices VALUES(253,'vat 20 ee','Unknown Supplier',19.14000000000000056,'2025-06-20 16:26:06');
CREATE TABLE stock_price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient TEXT NOT NULL,
  old_price REAL NOT NULL,
  new_price REAL NOT NULL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE ingredient_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  ingredients TEXT,
  allergens TEXT,
  scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders_backup(
  id INT,
  meal_name TEXT,
  quantity INT,
  total_price REAL,
  table_number TEXT,
  order_status TEXT,
  created_at NUM,
  price_per_unit REAL,
  paid INT,
  batch_id TEXT,
  category TEXT,
  meal_id INT
);
CREATE TABLE order_batches (
        id TEXT PRIMARY KEY,
        table_number TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , delivery_status TEXT DEFAULT 'pending', delivery_code TEXT);
INSERT INTO order_batches VALUES('c42a8be7-012b-4493-9984-ec8e5a81eab0','Table 1','2025-05-06 18:13:55','pending',NULL);
INSERT INTO order_batches VALUES('aec3a8a0-4296-479e-a19d-e9f9b89e78a5','Table 2','2025-05-06 18:43:18','pending',NULL);
INSERT INTO order_batches VALUES('76814eb0-1d7a-4845-8152-8828953ae4c6','Table 1','2025-05-06 19:21:16','pending',NULL);
INSERT INTO order_batches VALUES('210bc083-5272-4254-92ce-d1e662a328b2','Table 6','2025-05-12 20:30:00','pending',NULL);
INSERT INTO order_batches VALUES('c09c9c9e-a8f2-4f2c-aafb-cc9e1950ca22','Table 3','2025-05-13 20:12:33','pending',NULL);
INSERT INTO order_batches VALUES('7cce2f57-8724-4128-897a-83aacf328e37','Table 4','2025-05-15 12:50:52','pending',NULL);
INSERT INTO order_batches VALUES('79137ef3-a6a8-4af0-9e25-e2d14d1df1a1','Table 5','2025-05-15 15:18:49','pending',NULL);
INSERT INTO order_batches VALUES('f083ba41-91ea-42de-b9a0-e14f0414ee0c','Table 5','2025-05-15 15:31:06','pending',NULL);
INSERT INTO order_batches VALUES('2ba54296-81e5-4a01-b73f-75b1a29d2b89','Table 5','2025-05-15 15:34:14','pending',NULL);
INSERT INTO order_batches VALUES('d2b61504-ab78-427c-94b1-e74520ff9768','Table 5','2025-05-15 15:35:14','pending',NULL);
INSERT INTO order_batches VALUES('051a4625-341b-4473-a62e-3503e86fca97','Table 5','2025-05-15 15:37:26','pending',NULL);
INSERT INTO order_batches VALUES('8ab47d99-5f52-4ca8-ac0c-67054ced8589','Table 11','2025-05-15 15:38:56','pending',NULL);
INSERT INTO order_batches VALUES('5ff56592-afab-4e0a-a1d6-3283654423f9','Table 7','2025-05-15 15:51:38','pending',NULL);
INSERT INTO order_batches VALUES('361257a1-b6ad-45cd-b65f-3ca6b42d62b6','Table 1','2025-05-15 16:16:56','pending',NULL);
INSERT INTO order_batches VALUES('bb2b2856-1947-4c12-acac-43035bc82768','Table 1','2025-05-15 16:19:08','pending',NULL);
INSERT INTO order_batches VALUES('8a42a771-73ac-452e-8c8e-4c5a408483df','Table 8','2025-05-15 16:22:24','pending',NULL);
INSERT INTO order_batches VALUES('3d3a1fdb-198f-4f84-a757-60b9c574383e','Table 1','2025-05-15 16:24:54','pending',NULL);
INSERT INTO order_batches VALUES('5d725aa0-35ea-484a-9c71-3ee09d33ada8','Table 10','2025-05-15 17:51:44','pending',NULL);
INSERT INTO order_batches VALUES('d259d327-c4d4-4d91-9cb3-daa48059e474','Table 9','2025-05-15 17:52:11','pending',NULL);
INSERT INTO order_batches VALUES('fa50469b-a072-4424-b9c0-8974963acd8b','Table 12','2025-05-15 17:54:50','pending',NULL);
INSERT INTO order_batches VALUES('7dbae182-efa3-4e39-b83b-f33810572cca','Table 2','2025-05-15 18:31:17','pending',NULL);
INSERT INTO order_batches VALUES('5c1e945e-259a-4d9d-9748-cd62488ac2e6','Table 8','2025-05-15 19:42:38','pending',NULL);
INSERT INTO order_batches VALUES('1722c829-e693-4b2c-90e0-fec578344e50','Table 2','2025-05-16 08:06:15','pending',NULL);
INSERT INTO order_batches VALUES('5900589e-853c-4cb3-b280-f712f44ab351','Table 1','2025-05-16 08:06:42','pending',NULL);
INSERT INTO order_batches VALUES('daf0c039-ead3-43e3-95d2-a0508bdf36f1','Table 1','2025-05-16 08:14:44','pending',NULL);
INSERT INTO order_batches VALUES('271e64d5-9787-4abd-a14b-24df79d9ab4b','Table 1','2025-05-16 08:17:47','pending',NULL);
INSERT INTO order_batches VALUES('1877d5cc-8594-4a64-b6aa-91e0158be41f','Table 1','2025-05-16 08:20:25','pending',NULL);
INSERT INTO order_batches VALUES('93e7d9a7-c703-4a5e-bbb7-2e4c3072d70e','Table 1','2025-05-16 08:21:41','pending',NULL);
INSERT INTO order_batches VALUES('2d4e4080-98a8-421a-a08f-d5c4c0b047e2','Table 2','2025-05-17 07:58:23','pending',NULL);
INSERT INTO order_batches VALUES('6cd04cb8-69b5-4954-afd1-abff80bb34f4','Table 1','2025-05-17 08:03:56','pending',NULL);
INSERT INTO order_batches VALUES('2856d3a5-dd12-4575-924b-3a591ccf377b','Table 1','2025-05-17 20:51:06','pending',NULL);
INSERT INTO order_batches VALUES('aa7f2287-dc84-4aa7-bc5f-06a7bb9d1f2e','Table 1','2025-05-17 20:52:27','pending',NULL);
INSERT INTO order_batches VALUES('0c91e406-3742-4924-99e8-3b7d6bcce6cc','Table 1','2025-05-17 21:01:29','pending',NULL);
INSERT INTO order_batches VALUES('2b4da580-1300-43f8-88b4-4aeb7d7114bd','Table 1','2025-05-20 16:42:13','pending',NULL);
INSERT INTO order_batches VALUES('3aeb1a41-b7c3-40b7-b1b8-c3995de84052','Table 2','2025-05-20 16:48:23','pending',NULL);
INSERT INTO order_batches VALUES('7a2c6f5d-1983-4ce8-b178-657d0fb8feee','Table 1','2025-05-20 17:41:44','pending',NULL);
INSERT INTO order_batches VALUES('47cd9c8b-ee94-49c9-81a5-0fc2b6a8bd9c','Table 1','2025-05-20 17:42:24','pending',NULL);
INSERT INTO order_batches VALUES('8c07b1e8-9ed8-4182-ac92-cf5fe03f3e1d','Table 1','2025-05-20 17:42:51','pending',NULL);
INSERT INTO order_batches VALUES('7d67ac00-1026-414c-8827-bf33f8f48274','Table 1','2025-05-20 17:43:30','pending',NULL);
INSERT INTO order_batches VALUES('585bbc09-7bb2-40ba-adbd-17ce83a540ee','Table 2','2025-05-20 17:46:20','pending',NULL);
INSERT INTO order_batches VALUES('514cf476-0b7d-4a47-afe8-9300c0c30ffd','Table 1','2025-05-20 17:48:30','pending',NULL);
INSERT INTO order_batches VALUES('fc6395db-7ab1-4f6d-bad1-08cb75e76eea','Table 1','2025-05-20 17:50:45','pending',NULL);
INSERT INTO order_batches VALUES('47d06000-6e08-4287-b31f-f9df89a24c74','Table 1','2025-05-20 17:55:03','pending',NULL);
INSERT INTO order_batches VALUES('61fb2c16-75c9-4278-bd92-96883c34bb81','Table 1','2025-05-20 18:00:10','pending',NULL);
INSERT INTO order_batches VALUES('0817bbd5-661a-430f-8481-c7d17b6d8999','Table 1','2025-05-20 18:16:38','pending',NULL);
INSERT INTO order_batches VALUES('50648e04-f0ef-4633-98b0-cddb49996448','Table 1','2025-05-20 18:38:49','pending',NULL);
INSERT INTO order_batches VALUES('8f42e0b1-5219-46d7-ab5a-ef22edc530c2','Table 1','2025-05-20 18:42:36','pending',NULL);
INSERT INTO order_batches VALUES('89704425-bb90-4d72-a0f4-e200b6672108','Table 1','2025-05-20 18:46:12','pending',NULL);
INSERT INTO order_batches VALUES('3e03695e-4df9-4114-a31f-baccacdf17a9','Table 1','2025-05-20 18:48:06','pending',NULL);
INSERT INTO order_batches VALUES('c7439871-abf8-4fda-8808-18458cf933f3','Table 1','2025-05-20 19:09:03','pending',NULL);
INSERT INTO order_batches VALUES('30d31895-bf5b-46fa-b718-5eb2966e1e7b','Table 1','2025-05-20 19:10:51','pending',NULL);
INSERT INTO order_batches VALUES('1f4789d9-e94b-4429-8b9d-a4ee47622fba','Table 1','2025-05-20 19:34:00','pending',NULL);
INSERT INTO order_batches VALUES('5c447617-ce3b-43f8-a911-4026be2c71f7','Table 1','2025-05-20 19:40:13','pending',NULL);
INSERT INTO order_batches VALUES('804034b1-1fed-4b21-9652-7a1c1a161a82','Table 1','2025-05-20 19:43:19','pending',NULL);
INSERT INTO order_batches VALUES('30bacb65-34fc-45cb-a8bc-b0ab2af08bc9','Table 1','2025-05-20 19:48:45','pending',NULL);
INSERT INTO order_batches VALUES('ffc37fd2-5256-4c6c-b21b-482dd27e2e9f','Table 1','2025-05-20 20:19:20','pending',NULL);
INSERT INTO order_batches VALUES('4193e3f4-12f3-48e0-b2e4-b0f361a5782d','Table 1','2025-05-20 20:19:30','pending',NULL);
INSERT INTO order_batches VALUES('69782a60-f88f-4423-9645-4f486a5ff7e5','Table 1','2025-05-22 13:14:19','pending',NULL);
INSERT INTO order_batches VALUES('45845287-770b-4134-961a-44c0a00b566a','Table 1','2025-05-22 13:14:47','pending',NULL);
INSERT INTO order_batches VALUES('959a22ed-9d31-4404-8823-79ea2b84f4df','Table 1','2025-05-22 14:36:20','pending',NULL);
INSERT INTO order_batches VALUES('4e53c3da-b89e-41ce-ba01-4c8339d10894','Table 1','2025-05-22 14:39:24','pending',NULL);
INSERT INTO order_batches VALUES('2baeb070-9537-4924-b259-8ef86390ea30','Table 1','2025-05-22 14:50:19','pending',NULL);
INSERT INTO order_batches VALUES('7f994129-255d-48ea-913e-e8bee430f5d0','Table 1','2025-05-22 14:53:34','pending',NULL);
INSERT INTO order_batches VALUES('63f41757-ba3c-4084-baed-8c3c55d0e307','Table 1','2025-05-22 14:53:58','pending',NULL);
INSERT INTO order_batches VALUES('1df4fa4f-3193-4871-934a-b743d363d78b','Table 1','2025-05-22 14:54:31','pending',NULL);
INSERT INTO order_batches VALUES('28c8c0dd-e72f-4907-811b-94312ce8a175','Table 1','2025-05-22 14:54:45','pending',NULL);
INSERT INTO order_batches VALUES('1cf9e3cb-864b-44bc-80ca-7415b0742fe2','Table 2','2025-05-22 14:55:22','pending',NULL);
INSERT INTO order_batches VALUES('98b9d6b7-5a7b-4d54-a649-4df70a7fc388','Table 2','2025-05-22 14:55:27','pending',NULL);
INSERT INTO order_batches VALUES('e323a47b-1982-4177-87a4-f708bfab7dba','Table 1','2025-05-22 14:56:28','pending',NULL);
INSERT INTO order_batches VALUES('d48d1619-f6c9-429a-8cad-786b766091fc','Table 1','2025-05-22 15:02:45','pending',NULL);
INSERT INTO order_batches VALUES('f6e242e6-a854-4b4d-9cd2-de14f9667915','Table 2','2025-05-22 15:06:52','pending',NULL);
INSERT INTO order_batches VALUES('6e040aff-dc09-4296-b86f-702ae1bbfdab','Table 2','2025-05-22 15:11:43','pending',NULL);
INSERT INTO order_batches VALUES('20d2bb28-537b-473f-84dd-cf286ea59db0','Table 1','2025-05-22 15:20:14','pending',NULL);
INSERT INTO order_batches VALUES('d3611ac2-cb0c-4b9f-b7df-dd8fa94c9247','Table 1','2025-05-22 15:20:57','pending',NULL);
INSERT INTO order_batches VALUES('70362157-0a3e-40f3-a1af-ba1a3ac6b1b5','Table 1','2025-05-22 15:27:28','pending',NULL);
INSERT INTO order_batches VALUES('ffb57471-3db9-4eff-9ea3-2cd205552121','Table 1','2025-05-22 15:32:40','pending',NULL);
INSERT INTO order_batches VALUES('7c7839d9-a364-4b5c-8202-ae0d3c74c166','Table 1','2025-05-22 15:48:47','pending',NULL);
INSERT INTO order_batches VALUES('84926257-7c63-4589-a379-0df7c1db8afe','Table 1','2025-05-22 15:57:22','pending',NULL);
INSERT INTO order_batches VALUES('db25f7a5-f4d7-4411-9a90-b184d4d29fed','Table 1','2025-05-22 16:12:51','pending',NULL);
INSERT INTO order_batches VALUES('4fb2c208-8747-499d-be26-bc63c08f0bda','Table 1','2025-05-22 17:59:26','pending',NULL);
INSERT INTO order_batches VALUES('f97d5656-74a5-4ff8-a85e-aa90d1e447bc','Table 1','2025-05-22 18:06:57','pending',NULL);
INSERT INTO order_batches VALUES('84e9ca18-b371-4a5f-b4ef-52069da1e80e','Table 1','2025-05-22 18:20:54','pending',NULL);
INSERT INTO order_batches VALUES('1cb7cee6-dc67-4cf0-a142-86de3076d4b9','Table 1','2025-05-22 18:25:36','pending',NULL);
INSERT INTO order_batches VALUES('b01a9863-6444-4042-bade-40e869736883','Table 1','2025-05-22 19:12:40','pending',NULL);
INSERT INTO order_batches VALUES('c92564a6-913b-4fd7-9b7e-b62735ca4026','Table 1','2025-05-22 19:13:28','pending',NULL);
INSERT INTO order_batches VALUES('50a51a0a-5b0b-4d05-9567-177e78d6d1c3','Table 1','2025-05-24 21:04:20','pending',NULL);
INSERT INTO order_batches VALUES('d733f5d6-a045-477d-a216-d923774d11cd','Table 1','2025-05-26 09:53:50','pending',NULL);
INSERT INTO order_batches VALUES('569a68b0-6b88-4673-a5ce-e8a1601478fa','Table 1','2025-05-26 10:01:25','pending',NULL);
INSERT INTO order_batches VALUES('97b3f154-6427-4c1b-9c39-d31de3bbc16d','Table 1','2025-05-26 13:59:22','pending',NULL);
INSERT INTO order_batches VALUES('c46296cf-d177-4a32-b050-0efd4614e4e5','Table 1','2025-05-26 17:08:58','pending',NULL);
INSERT INTO order_batches VALUES('20291810-9a1c-456f-a04f-8be47e56878a','Table 2','2025-05-27 21:55:53','pending',NULL);
INSERT INTO order_batches VALUES('73ee07c3-355d-4a55-9c6e-169396e17aa8','Table 1','2025-05-27 21:58:54','pending',NULL);
INSERT INTO order_batches VALUES('a866adc1-e6c2-4d63-9a1f-cf59d1bf4f6e','Table 1','2025-05-27 21:59:21','pending',NULL);
INSERT INTO order_batches VALUES('291dc682-d7dc-42eb-bc3a-45076b862344','Table 1','2025-05-27 22:02:09','pending',NULL);
INSERT INTO order_batches VALUES('7ae751f2-18ba-448b-936a-ff17a31a7ec3','Table 1','2025-05-27 22:02:43','pending',NULL);
INSERT INTO order_batches VALUES('12336a20-f261-4d87-811a-6ebc2402542c','Table 1','2025-05-28 21:21:27','pending',NULL);
INSERT INTO order_batches VALUES('79a99aa6-bf2b-45d2-b709-b1c17fe86535','Table 1','2025-05-28 21:38:56','pending',NULL);
INSERT INTO order_batches VALUES('65bae26c-f9c4-4bd1-a84c-ebd6bca2a5ff','Table 1','2025-05-28 22:08:07','pending',NULL);
INSERT INTO order_batches VALUES('d75c5127-ce7b-4bf0-ba14-c00d5732e1ce','Table 1','2025-05-28 22:08:27','pending',NULL);
INSERT INTO order_batches VALUES('aa649bc9-7a96-438d-9c53-88cec309c4e8','Table 1','2025-05-28 22:13:55','pending',NULL);
INSERT INTO order_batches VALUES('2c3dfa80-ba95-4625-89b0-c036aad3ff1c','Table 1','2025-06-01 22:28:41','pending',NULL);
INSERT INTO order_batches VALUES('0024e7a3-9974-4609-b1bc-05500ffe9035','delivery','2025-06-05 15:48:58','pending',NULL);
INSERT INTO order_batches VALUES('289ff4e2-a404-489b-b1bd-6cea1f36b058','delivery','2025-06-05 15:49:05','pending',NULL);
INSERT INTO order_batches VALUES('5707d32f-4a24-41ce-9adf-aca6ca9df98e','delivery','2025-06-05 15:53:35','pending',NULL);
INSERT INTO order_batches VALUES('a3a157c0-7a03-40ee-823d-b799c9ebbd6b','delivery','2025-06-05 15:54:23','pending',NULL);
INSERT INTO order_batches VALUES('db2426e3-5b08-4602-b895-de69035cb2f3','delivery','2025-06-05 15:54:37','pending',NULL);
INSERT INTO order_batches VALUES('272f5d99-9da4-4996-bc9d-11ebd62fbcce','delivery','2025-06-05 15:55:14','pending',NULL);
INSERT INTO order_batches VALUES('7910dab1-b187-41b5-9ce3-960087b6e497','delivery','2025-06-05 16:04:16','accepted','2034');
INSERT INTO order_batches VALUES('c5e2d15c-0cf2-4be7-8b35-cca6b82c8c84','Table 1','2025-06-05 16:40:18','pending',NULL);
INSERT INTO order_batches VALUES('8928b677-ecb1-4c73-b268-1a7496b128aa','delivery','2025-06-05 19:11:36','declined',NULL);
INSERT INTO order_batches VALUES('4352a70c-b7f0-40e1-af15-42c01003a68e','delivery','2025-06-05 19:49:10','declined',NULL);
INSERT INTO order_batches VALUES('5dd9221f-8bb5-42ae-9535-49deab7d35fe','delivery','2025-06-05 19:49:28','accepted','9895');
INSERT INTO order_batches VALUES('78a119c1-6c2b-4bab-adde-184383b6e945','Table 1','2025-06-05 20:22:58','pending',NULL);
INSERT INTO order_batches VALUES('423860a9-1b64-4539-8cbe-2eb2bb87bd89','Table 1','2025-06-05 21:46:32','pending',NULL);
INSERT INTO order_batches VALUES('2292c19a-dd9c-47dc-815b-adbff5d0a873','Table 1','2025-06-07 07:22:56','pending',NULL);
INSERT INTO order_batches VALUES('b0676832-0323-4244-9bc2-e09c2ea22edd','Table 1','2025-06-07 07:26:34','pending',NULL);
INSERT INTO order_batches VALUES('a38aa8ae-9d5a-4f10-99b4-9e28ce511d0c','Table 1','2025-06-07 19:23:44','pending',NULL);
INSERT INTO order_batches VALUES('7b7f3dc1-e220-4ab3-9176-cf7ecbca68da','Table 1','2025-06-07 19:43:15','pending',NULL);
INSERT INTO order_batches VALUES('9ece3752-bb16-445d-85b1-bae02b322c40','Table 1','2025-06-07 20:30:07','pending',NULL);
INSERT INTO order_batches VALUES('74bcb9ac-f298-4cc3-883f-5ea0655f0138','Table 1','2025-06-08 22:04:40','pending',NULL);
INSERT INTO order_batches VALUES('a0f39715-52c1-44dd-9813-c73186fa4829','Table 1','2025-06-09 09:35:58','pending',NULL);
INSERT INTO order_batches VALUES('d2738d82-c093-412b-a8d0-0c328643563f','delivery','2025-06-09 09:40:28','accepted','3892');
INSERT INTO order_batches VALUES('4c67656d-6771-4a92-82cf-96b3ba395eca','Table 1','2025-06-09 09:44:13','pending',NULL);
INSERT INTO order_batches VALUES('ea31f8d4-ed08-42a7-81f5-cb3bae50cb83','Table 11','2025-06-09 09:44:30','pending',NULL);
INSERT INTO order_batches VALUES('3848688e-14f6-4fe8-9ef1-49de3ea7b82f','Table 1','2025-06-09 19:18:43','pending',NULL);
INSERT INTO order_batches VALUES('1597449b-2f71-4edc-8b16-35e9ab0d055b','Table 1','2025-06-16 20:43:40','pending',NULL);
INSERT INTO order_batches VALUES('55a6386e-1f69-4212-9436-a1fd105e260b','Table 1','2025-06-20 16:26:53','pending',NULL);
INSERT INTO order_batches VALUES('e41b0e7c-b139-4d1f-bed9-27997adaea23','Table 1','2025-06-20 20:50:13','pending',NULL);
INSERT INTO order_batches VALUES('a1022af3-28b6-4582-a03c-6678aff92046','Table 1','2025-06-20 20:52:26','pending',NULL);
INSERT INTO order_batches VALUES('367418e1-7b9c-4a1e-849a-2d491302caf0','Table 1','2025-06-22 21:56:08','pending',NULL);
INSERT INTO order_batches VALUES('8d636ffe-6230-4567-a309-702ac949b20b','Table 1','2025-06-23 17:47:54','pending',NULL);
INSERT INTO order_batches VALUES('d2720e7a-9e8d-4311-a5d5-c1b6cf5a9c06','Table 1','2025-06-23 18:02:05','pending',NULL);
INSERT INTO order_batches VALUES('209e9734-7e0e-47d5-af85-10717dbe852d','Table 1','2025-06-23 18:02:11','pending',NULL);
INSERT INTO order_batches VALUES('d082ffce-aa79-4687-a9cc-33bf5c423509','Table 1','2025-06-25 13:34:59','pending',NULL);
INSERT INTO order_batches VALUES('4e76a5d9-3631-41d2-9e8e-adbc75e0f945','Table 2','2025-06-25 13:44:19','pending',NULL);
INSERT INTO order_batches VALUES('a793ca1e-d4b7-49bd-a73a-58a928c06d38','Table 1','2025-06-25 21:53:48','pending',NULL);
INSERT INTO order_batches VALUES('bb0d7453-dc16-4f20-acb5-d89d2afbe602','Table 1','2025-06-25 22:29:28','pending',NULL);
INSERT INTO order_batches VALUES('1ca02b5f-dbea-4b08-9f15-62815b3dcae8','Table 1','2025-06-26 08:50:09','pending',NULL);
INSERT INTO order_batches VALUES('933bb163-01fd-4aa3-aade-504f04406056','Table 1','2025-06-27 21:20:34','pending',NULL);
INSERT INTO order_batches VALUES('a6567547-7c2b-4006-b5fe-2d0794305fdb','Table 1','2025-06-30 18:10:58','pending',NULL);
INSERT INTO order_batches VALUES('1ce15751-a6a7-41cd-b21c-7d2f84cad9dd','47','2025-07-03 19:33:30','pending',NULL);
INSERT INTO order_batches VALUES('5bdacd8d-afb4-4c9d-8167-4965a76d6ef7','Table 1','2025-07-03 19:41:18','pending',NULL);
INSERT INTO order_batches VALUES('28bbf534-0940-406c-92fa-9ab8506d2861','1','2025-07-03 20:17:01','pending',NULL);
INSERT INTO order_batches VALUES('90a67028-d4b5-41a0-9a1f-1a0354f60955','1','2025-07-04 18:05:43','pending',NULL);
INSERT INTO order_batches VALUES('d3f8f5a4-854b-4371-b96f-992214bc4a65','1','2025-07-04 19:06:01','pending',NULL);
INSERT INTO order_batches VALUES('5c0bf78a-d62f-4183-bdb7-93277b0af226','5','2025-07-04 19:11:10','pending',NULL);
INSERT INTO order_batches VALUES('3b84909f-2f1c-4dd0-9f28-aeb477d5c83c','4','2025-07-04 19:12:18','pending',NULL);
INSERT INTO order_batches VALUES('a6570e5b-ae7f-4528-8201-c1facbeab29d','4','2025-07-04 19:35:23','pending',NULL);
INSERT INTO order_batches VALUES('7ff0af4f-316f-4b01-8a41-c4864f037435','4','2025-07-04 19:37:58','pending',NULL);
INSERT INTO order_batches VALUES('6c785c68-948e-4fd3-a7d6-6c5c53f81728','4','2025-07-04 19:53:04','pending',NULL);
INSERT INTO order_batches VALUES('7ff10526-f14f-4493-a5f4-d499ecb21e30','1','2025-07-04 19:59:40','pending',NULL);
INSERT INTO order_batches VALUES('64c83cea-8928-47bf-80fd-e8374c5b311f','1','2025-07-04 19:59:53','pending',NULL);
INSERT INTO order_batches VALUES('b616e065-bc48-4831-8419-1b138795cc52','1','2025-07-04 20:00:13','pending',NULL);
INSERT INTO order_batches VALUES('01cf310f-96ab-434e-8bce-3689b8edf332','5','2025-07-04 20:01:20','pending',NULL);
INSERT INTO order_batches VALUES('c7f3ebfb-e505-4da3-8cec-69d0995467a1','5','2025-07-04 20:03:06','pending',NULL);
INSERT INTO order_batches VALUES('0195c49a-0c26-4f16-9512-4781a68921a8','5','2025-07-04 20:03:16','pending',NULL);
INSERT INTO order_batches VALUES('09326fa8-6bd1-466e-a710-d7eb4662e10b','5','2025-07-04 20:03:38','pending',NULL);
INSERT INTO order_batches VALUES('d97fd981-72b7-46ed-93ba-f112e8bf2939','5','2025-07-04 20:04:49','pending',NULL);
INSERT INTO order_batches VALUES('6940c97b-2e2e-4ca4-865b-e7d785c9ae91','5','2025-07-04 20:17:14','pending',NULL);
INSERT INTO order_batches VALUES('cec6839b-94cd-44cc-a5f4-2657f8904d51','2','2025-07-04 20:17:26','pending',NULL);
INSERT INTO order_batches VALUES('c810030e-70fb-4c0a-9693-e3d2973c0022','1','2025-07-04 20:17:39','pending',NULL);
INSERT INTO order_batches VALUES('c485ab71-e685-47c9-9677-c30ed8784715','4','2025-07-04 20:17:51','pending',NULL);
INSERT INTO order_batches VALUES('6e044972-bc24-4afd-b2e6-110068816754','5','2025-07-04 20:18:58','pending',NULL);
INSERT INTO order_batches VALUES('79591895-fe37-44a2-a052-412b5cc4d286','2','2025-07-04 20:21:54','pending',NULL);
INSERT INTO order_batches VALUES('671f31da-9470-4ad4-8e5e-226d906968ca','5','2025-07-04 20:22:42','pending',NULL);
INSERT INTO order_batches VALUES('47f15c4b-fc59-43b2-ac40-9496ebaa68dc','5','2025-07-04 20:38:34','pending',NULL);
INSERT INTO order_batches VALUES('7aa95a73-e716-44a4-a768-fb8c52962418','1','2025-07-04 20:38:47','pending',NULL);
INSERT INTO order_batches VALUES('378baf5c-4083-4faa-9ea8-51c5e7ca4c43','1','2025-07-05 06:06:09','pending',NULL);
INSERT INTO order_batches VALUES('dd74e13a-1c67-44fa-a5f0-8d67c329bddb','2','2025-07-05 06:06:21','pending',NULL);
INSERT INTO order_batches VALUES('39b79da1-03ef-4640-90bb-1e06ef7a860f','1','2025-07-05 06:07:21','pending',NULL);
INSERT INTO order_batches VALUES('d078c679-bbdb-4a82-a535-16f4bb71440b','Table 2','2025-07-07 06:45:16','pending',NULL);
INSERT INTO order_batches VALUES('55fe6e1f-83d5-4463-927a-f1012a9a4900','Table 2','2025-07-07 06:45:27','pending',NULL);
INSERT INTO order_batches VALUES('89fb9c40-3e31-4024-8bf1-26eca38ecd88','Table 2','2025-07-07 06:45:38','pending',NULL);
INSERT INTO order_batches VALUES('6105c0cb-6f6b-4fd1-96c4-b8275a13e401','Table 4','2025-07-07 06:46:01','pending',NULL);
INSERT INTO order_batches VALUES('251b89d1-dbc1-46fb-8b1e-f5a3bab1a875','Table 5','2025-07-07 06:46:32','pending',NULL);
INSERT INTO order_batches VALUES('7b2db7f9-3e5b-4de6-9865-31cefa583b39','Table 5','2025-07-07 06:46:50','pending',NULL);
INSERT INTO order_batches VALUES('9104332c-2d75-4bff-89b4-bbf32972617b','Table 1','2025-07-07 06:47:14','pending',NULL);
INSERT INTO order_batches VALUES('d835bfcc-b5e5-456f-b16b-ed15a68e6cca','Table 2','2025-07-07 06:47:33','pending',NULL);
INSERT INTO order_batches VALUES('07547b3c-45f9-4cf1-b4c3-df4f4cad6c5a','1','2025-07-14 18:21:09','pending',NULL);
INSERT INTO order_batches VALUES('d6707eb4-32e2-4365-a37d-53826bccfd80','1','2025-07-14 18:22:12','pending',NULL);
INSERT INTO order_batches VALUES('7327cd3e-9a60-4e37-83fe-d20df8062f4a','3','2025-07-14 18:23:02','pending',NULL);
INSERT INTO order_batches VALUES('40933d2f-cde8-4834-8e1c-1c7e1a551019','2','2025-07-14 19:04:59','pending',NULL);
INSERT INTO order_batches VALUES('a82fbb63-90e1-48aa-9672-3d24dfde7e08','1','2025-07-14 19:11:20','pending',NULL);
INSERT INTO order_batches VALUES('682614d5-cbb3-4abf-9236-23eb8b231ddc','1','2025-07-14 19:24:40','pending',NULL);
INSERT INTO order_batches VALUES('95d8bf4a-7dff-44a0-8fdc-5943633d45cc','4','2025-07-14 19:25:16','pending',NULL);
INSERT INTO order_batches VALUES('42b2a42a-5ffa-452e-b5f9-4acab60191b8','3','2025-07-14 19:29:05','pending',NULL);
INSERT INTO order_batches VALUES('3396c3d3-d0f0-4482-8f5d-8759799df823','1','2025-07-14 19:40:33','pending',NULL);
INSERT INTO order_batches VALUES('4a964ec1-f995-4812-9406-44cfeec41733','1','2025-07-14 19:49:14','pending',NULL);
INSERT INTO order_batches VALUES('657304ea-0881-4d1c-b464-65a397dbbbb1','2','2025-07-14 19:49:42','pending',NULL);
INSERT INTO order_batches VALUES('78117f3a-4d88-453d-a44b-590953605f7a','1','2025-07-14 20:09:56','pending',NULL);
INSERT INTO order_batches VALUES('a71b618b-855d-45a6-998b-6c36ccc5ed6e','2','2025-07-14 20:10:10','pending',NULL);
INSERT INTO order_batches VALUES('25479d0e-a712-4020-bf06-0bbcf4706ec3','1','2025-07-14 20:10:44','pending',NULL);
INSERT INTO order_batches VALUES('1f3d79d1-e57f-4067-8aa2-6028e586a915','1','2025-07-14 20:11:12','pending',NULL);
INSERT INTO order_batches VALUES('982077c3-eb2f-4f67-822e-73fe9864c4fd','3','2025-07-14 20:11:50','pending',NULL);
INSERT INTO order_batches VALUES('0c20a5dd-84df-498e-97f2-26580432a1f4','4','2025-07-14 20:21:36','pending',NULL);
INSERT INTO order_batches VALUES('61e0172e-2931-4208-9845-451e517c58c2','1','2025-07-14 20:35:04','pending',NULL);
INSERT INTO order_batches VALUES('e643d8a9-a9fc-4b38-bdfd-354737cc6098','1','2025-07-17 10:57:43','pending',NULL);
INSERT INTO order_batches VALUES('205b70a5-c0ed-4781-92ea-0c423129436c','1','2025-07-17 13:09:36','pending',NULL);
INSERT INTO order_batches VALUES('fad9344c-00a3-48d2-917b-232389cc3b0f','2','2025-07-17 13:10:04','pending',NULL);
INSERT INTO order_batches VALUES('d0616ca6-5499-45cf-b792-dfe02951c413','3','2025-07-17 13:10:21','pending',NULL);
INSERT INTO order_batches VALUES('908f7402-9c40-44c6-827c-b1075bc28742','1','2025-07-17 13:39:18','pending',NULL);
INSERT INTO order_batches VALUES('78b004dc-5a1a-430e-9e50-58f1465ff305','2','2025-07-17 13:47:51','pending',NULL);
INSERT INTO order_batches VALUES('a911067c-3a43-40e9-9b5b-eda7e1741622','2','2025-07-17 13:48:23','pending',NULL);
INSERT INTO order_batches VALUES('db9b97c7-8237-4202-b745-afe6cec294e5','1','2025-07-17 14:35:28','pending',NULL);
INSERT INTO order_batches VALUES('7d6343d7-9008-4f32-9f51-093351d86c68','2','2025-07-17 14:43:40','pending',NULL);
INSERT INTO order_batches VALUES('92aec75d-52e4-42f7-a85b-141c7019b652','2','2025-07-17 15:07:48','pending',NULL);
INSERT INTO order_batches VALUES('1e2e15a0-04a0-4382-9da9-edf920216f0e','1','2025-07-17 15:26:19','pending',NULL);
INSERT INTO order_batches VALUES('8a83fe99-2a59-4883-831f-77f3ca541822','2','2025-07-17 15:27:07','pending',NULL);
INSERT INTO order_batches VALUES('dd535b2e-699c-4de3-93df-f204e098380a','2','2025-07-17 15:40:11','pending',NULL);
INSERT INTO order_batches VALUES('d551265f-77f4-4e48-8b65-aac954f6b16f','2','2025-07-17 16:04:45','pending',NULL);
INSERT INTO order_batches VALUES('8802ceaa-930e-49e3-a6f1-0e0aebf8b620','2','2025-07-17 16:07:58','pending',NULL);
INSERT INTO order_batches VALUES('0a5f7746-7987-4886-8781-bc2da86ea9d8','2','2025-07-17 16:32:00','pending',NULL);
INSERT INTO order_batches VALUES('061d7a42-7c5c-4fbc-9af3-3ac0d8808656','2','2025-07-17 16:32:49','pending',NULL);
INSERT INTO order_batches VALUES('9640dafd-ce27-460b-972b-7a49162f6cb3','2','2025-07-17 16:42:33','pending',NULL);
INSERT INTO order_batches VALUES('202a7222-1211-4988-8e9d-c3a18ef38fd8','2','2025-07-17 16:50:24','pending',NULL);
INSERT INTO order_batches VALUES('9cdb7fc1-6ddf-43c2-985e-b50c9fbb457f','2','2025-07-17 16:53:06','pending',NULL);
INSERT INTO order_batches VALUES('48761c51-9662-4619-b660-56314d3f82f7','2','2025-07-17 16:54:52','pending',NULL);
INSERT INTO order_batches VALUES('fba09b74-6e1c-4423-978c-f8ba415b18fb','2','2025-07-17 17:08:35','pending',NULL);
INSERT INTO order_batches VALUES('9a246085-15d2-49c5-a3b9-6651929d031f','2','2025-07-17 17:12:08','pending',NULL);
INSERT INTO order_batches VALUES('45aa6966-4e08-44fd-a37f-4422f3624ad3','2','2025-07-17 17:13:11','pending',NULL);
INSERT INTO order_batches VALUES('5f16ce4b-467b-4897-96e1-173700b84097','2','2025-07-17 17:49:03','pending',NULL);
INSERT INTO order_batches VALUES('563e65a2-1dd8-4553-a4fd-0d91c2e02621','2','2025-07-17 17:50:01','pending',NULL);
INSERT INTO order_batches VALUES('0570407a-6251-422c-a540-30823dacf9b8','2','2025-07-17 21:35:41','pending',NULL);
INSERT INTO order_batches VALUES('855e7df1-7378-4e22-a133-b24fc5be347c','2','2025-07-20 20:12:16','pending',NULL);
INSERT INTO order_batches VALUES('38c38b10-d140-4f09-aecd-444f3c683926','1','2025-07-20 21:02:40','pending',NULL);
INSERT INTO order_batches VALUES('7954834d-a3aa-4590-9544-cc90ce584a4c','3','2025-07-21 13:36:54','pending',NULL);
INSERT INTO order_batches VALUES('33190bff-5474-432a-9daf-5006048c35d4','2','2025-07-21 13:37:53','pending',NULL);
INSERT INTO order_batches VALUES('b9cf5cac-250b-4493-9613-6074c80f968a','2','2025-07-21 14:53:08','pending',NULL);
INSERT INTO order_batches VALUES('7bddfa6f-950a-4953-aa04-2efb73ac7754','2','2025-07-21 19:18:40','pending',NULL);
INSERT INTO order_batches VALUES('33964c29-0db3-4813-8480-19e368db1d3d','2','2025-07-21 19:29:29','pending',NULL);
INSERT INTO order_batches VALUES('121db7c0-1301-49fb-9436-0d885f0690fc','2','2025-07-21 19:32:18','pending',NULL);
INSERT INTO order_batches VALUES('991e3de2-2192-4727-bde5-f288c16e1a83','2','2025-07-21 19:43:21','pending',NULL);
INSERT INTO order_batches VALUES('ac56a76a-031c-42e1-9592-f810ddcd55dd','2','2025-07-21 19:49:10','pending',NULL);
INSERT INTO order_batches VALUES('eadb0dbc-799b-4842-9433-28b1665ab04b','2','2025-07-21 19:50:14','pending',NULL);
INSERT INTO order_batches VALUES('81c6659a-a94f-4976-873f-26e07ccdee91','2','2025-07-21 20:16:50','pending',NULL);
INSERT INTO order_batches VALUES('9adc5684-2841-45ad-b922-699012797ee2','1','2025-07-24 10:09:02','pending',NULL);
INSERT INTO order_batches VALUES('88493814-fdc7-4550-ad4b-d6cd6b3dae36','2','2025-07-24 11:21:11','pending',NULL);
INSERT INTO order_batches VALUES('708bc335-690b-4bd1-90ee-24701113b478','2','2025-07-24 11:22:29','pending',NULL);
INSERT INTO order_batches VALUES('ef2a73b0-591e-42f2-a55a-44e354630402','2','2025-07-24 11:23:25','pending',NULL);
INSERT INTO order_batches VALUES('67653822-f6e4-4d11-ba8e-34eab9213096','2','2025-07-24 11:25:35','pending',NULL);
INSERT INTO order_batches VALUES('cc87edbe-aae8-4d88-948d-f775aed13e0d','2','2025-07-24 11:28:28','pending',NULL);
INSERT INTO order_batches VALUES('cb079475-d53d-4b92-9d68-196d0b015fdb','2','2025-07-24 11:37:37','pending',NULL);
INSERT INTO order_batches VALUES('f38fb477-dabb-4714-9372-2dab719c3a0d','4','2025-07-24 11:39:12','pending',NULL);
INSERT INTO order_batches VALUES('72247c92-a1af-4df6-a8ea-fa452c28dfdb','2','2025-07-24 18:34:06','pending',NULL);
INSERT INTO order_batches VALUES('a7b7db19-2c8d-4c1d-8072-0d2609ff8f13','2','2025-07-24 19:15:59','pending',NULL);
INSERT INTO order_batches VALUES('5f8e4097-aadc-4dca-87a4-793f9b98bff8','2','2025-07-24 19:55:47','pending',NULL);
INSERT INTO order_batches VALUES('bfa2c431-48d2-4abe-8c7f-da5494d9dddc','2','2025-07-24 20:15:03','pending',NULL);
INSERT INTO order_batches VALUES('089e510f-91e7-414c-99c7-817e03af43aa','2','2025-07-24 20:27:52','pending',NULL);
INSERT INTO order_batches VALUES('5fa70801-a1be-4a93-8c3c-baff4f6267ef','3','2025-08-11 20:35:58','pending',NULL);
INSERT INTO order_batches VALUES('57574190-11c2-4ac8-ac93-a4a723d045aa','1','2025-08-11 21:11:23','pending',NULL);
INSERT INTO order_batches VALUES('7540f6ab-cdde-4779-9e52-f9c370847fe1','2','2025-08-13 20:54:30','pending',NULL);
INSERT INTO order_batches VALUES('8aee3f43-5005-458e-a9b3-afbf55374306','1','2025-08-13 21:04:54','pending',NULL);
INSERT INTO order_batches VALUES('596e4ea1-bd62-4c9e-82cf-92b64ea76bc8','4','2025-08-13 21:28:04','pending',NULL);
INSERT INTO order_batches VALUES('8f23ba5f-3f98-4dea-a59d-b27b4188223d','4','2025-08-13 21:28:58','pending',NULL);
INSERT INTO order_batches VALUES('f28b920d-ffd4-49f4-9839-4c29c9a03a93','4','2025-08-14 05:07:05','pending',NULL);
INSERT INTO order_batches VALUES('96d31438-0521-4669-9360-03912a2932c7','1','2025-08-14 05:39:24','pending',NULL);
INSERT INTO order_batches VALUES('bdb81646-d457-4317-84b7-c0ffac5dc95f','1','2025-08-14 05:40:00','pending',NULL);
INSERT INTO order_batches VALUES('7e9ad6a7-4fc5-4251-9cd0-9ba41a94a6ab','4','2025-08-14 05:51:37','pending',NULL);
INSERT INTO order_batches VALUES('f71f5703-9e5b-40bc-b9fe-7ac834660bdf','1','2025-08-14 05:55:56','pending',NULL);
INSERT INTO order_batches VALUES('be916238-5108-4776-8353-8e995fe18e16','3','2025-08-14 06:12:28','pending',NULL);
INSERT INTO order_batches VALUES('9cc9e805-0c26-4504-b7a4-2f91e06fed7a','5','2025-08-14 06:13:51','pending',NULL);
INSERT INTO order_batches VALUES('0baead91-c867-4eb5-8483-babcd3d10e86','4','2025-08-15 06:38:55','pending',NULL);
INSERT INTO order_batches VALUES('fa3b6da5-e640-4f1a-8237-94f708d8d4be','4','2025-08-15 06:39:01','pending',NULL);
INSERT INTO order_batches VALUES('4dd2bfbe-f734-4e79-8d0a-7aa58051b717','4','2025-08-15 06:40:37','pending',NULL);
INSERT INTO order_batches VALUES('76f13213-d0c7-4c8a-a892-c6ebbeeec726','4','2025-08-15 06:44:39','pending',NULL);
CREATE TABLE drink_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drink_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        total_price REAL NOT NULL,
        table_number TEXT,
        order_status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        price_per_unit REAL DEFAULT 0,
        paid INTEGER DEFAULT 0,
        batch_id TEXT
      , order_time TEXT DEFAULT (datetime('now')));
INSERT INTO drink_orders VALUES(1,'Whiskey',1,5.0,NULL,'Pending','2025-05-16 08:28:14',0.0,0,NULL,'2025-05-16 08:28:14');
INSERT INTO drink_orders VALUES(2,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:16',0.0,0,NULL,'2025-05-16 08:28:16');
INSERT INTO drink_orders VALUES(3,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:17',0.0,0,NULL,'2025-05-16 08:28:17');
INSERT INTO drink_orders VALUES(4,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:21',0.0,0,NULL,'2025-05-16 08:28:21');
INSERT INTO drink_orders VALUES(5,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:21',0.0,0,NULL,'2025-05-16 08:28:21');
INSERT INTO drink_orders VALUES(6,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:22',0.0,0,NULL,'2025-05-16 08:28:22');
INSERT INTO drink_orders VALUES(7,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:23',0.0,0,NULL,'2025-05-16 08:28:23');
INSERT INTO drink_orders VALUES(8,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-16 08:28:23',0.0,0,NULL,'2025-05-16 08:28:23');
INSERT INTO drink_orders VALUES(9,'Whiskey',1,5.0,NULL,'Pending','2025-05-20 16:48:35',0.0,0,NULL,'2025-05-20 16:48:35');
INSERT INTO drink_orders VALUES(10,'Whiskey',1,5.0,NULL,'Pending','2025-05-20 16:48:35',0.0,0,NULL,'2025-05-20 16:48:35');
INSERT INTO drink_orders VALUES(11,'Whiskey',1,5.0,NULL,'Pending','2025-05-20 16:48:35',0.0,0,NULL,'2025-05-20 16:48:35');
INSERT INTO drink_orders VALUES(12,'Whiskey',1,5.0,NULL,'Pending','2025-05-26 20:07:09',0.0,0,NULL,'2025-05-26 20:07:09');
INSERT INTO drink_orders VALUES(13,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:23:09',0.0,0,NULL,'2025-05-28 21:23:09');
INSERT INTO drink_orders VALUES(14,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:23:11',0.0,0,NULL,'2025-05-28 21:23:11');
INSERT INTO drink_orders VALUES(15,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:23:11',0.0,0,NULL,'2025-05-28 21:23:11');
INSERT INTO drink_orders VALUES(16,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:23:11',0.0,0,NULL,'2025-05-28 21:23:11');
INSERT INTO drink_orders VALUES(17,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:23:11',0.0,0,NULL,'2025-05-28 21:23:11');
INSERT INTO drink_orders VALUES(18,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-28 21:23:13',0.0,0,NULL,'2025-05-28 21:23:13');
INSERT INTO drink_orders VALUES(19,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-28 21:23:13',0.0,0,NULL,'2025-05-28 21:23:13');
INSERT INTO drink_orders VALUES(20,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-28 21:23:13',0.0,0,NULL,'2025-05-28 21:23:13');
INSERT INTO drink_orders VALUES(21,'Nestle Pure Life Multipack fE',1,3.490000000000000213,NULL,'Pending','2025-05-28 21:23:14',0.0,0,NULL,'2025-05-28 21:23:14');
INSERT INTO drink_orders VALUES(22,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:40:34',0.0,0,NULL,'2025-05-28 21:40:34');
INSERT INTO drink_orders VALUES(23,'Whiskey',1,5.0,NULL,'Pending','2025-05-28 21:40:35',0.0,0,NULL,'2025-05-28 21:40:35');
CREATE TABLE restock_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT DEFAULT 'drinks',
        ordered_at DATETIME DEFAULT CURRENT_TIMESTAMP
      , supplier_id INTEGER, type TEXT DEFAULT 'ingredient', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  item_name TEXT,
  reason TEXT,
  reported_by TEXT,
  quantity REAL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO reports VALUES(1,10,'Whiskey','complaint','Max',2.0,'2025-05-13 22:12:15');
INSERT INTO reports VALUES(2,10,'Whiskey','b','Max',2.0,'2025-05-13 22:12:32');
INSERT INTO reports VALUES(3,41,'scrambled egg','wasted','Max',2.0,'2025-05-22 14:54:12');
INSERT INTO reports VALUES(4,43,'','broken','Max',3.0,'2025-05-22 14:55:00');
INSERT INTO reports VALUES(5,44,'scrambled egg','waste','Max',5.0,'2025-05-22 14:55:49');
INSERT INTO reports VALUES(6,68,'Spaghetti','waste','Max',25.0,'2025-05-26 17:09:48');
INSERT INTO reports VALUES(7,75,'Full English','Waste','Max',4.0,'2025-05-28 21:21:58');
INSERT INTO reports VALUES(8,81,'Full English','waste','Max',11.0,'2025-06-01 22:30:20');
INSERT INTO reports VALUES(9,113,'Full English','Broken','Max',1.0,'2025-06-09 09:45:40');
INSERT INTO reports VALUES(10,114,'Full English','Complaint','Max',1.0,'2025-06-09 19:19:06');
INSERT INTO reports VALUES(11,125,'Full English','refund','Max',1.0,'2025-06-23 17:50:57');
INSERT INTO reports VALUES(12,132,'Full English','Complaint','Max',1.0,'2025-06-25 13:41:44');
INSERT INTO reports VALUES(13,151,'Full English','wasteed','Max',1.0,'2025-07-04 19:12:57');
INSERT INTO reports VALUES(14,NULL,'Full English','overcooked','Max',1.0,'2025-08-14 22:00:58');
CREATE TABLE prepped_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT DEFAULT 'L', -- L (liters), Kg, etc.
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
, ingredients TEXT, allergens TEXT DEFAULT 'None', expiry_date TEXT, hold_temperature TEXT DEFAULT '0-5°C', shelf_life_hours INTEGER DEFAULT 72, min_required REAL DEFAULT 0);
INSERT INTO prepped_items VALUES(7,'Tuna Mayo',0.0,'L','2025-05-28 21:26:04','[{"ingredient":"tuna","amount":400},{"ingredient":"mayo","amount":150}]','None',NULL,'5',72,0.0);
CREATE TABLE meal_prepped_ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_name TEXT NOT NULL,
  prepped_item_name TEXT NOT NULL,
  amount_per_meal REAL NOT NULL
);
CREATE TABLE meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ingredients TEXT NOT NULL,
    allergens TEXT NOT NULL,
    calories REAL NOT NULL,
    price REAL NOT NULL,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'meals',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, supplier_id TEXT, paused INTEGER DEFAULT 0);
INSERT INTO meals VALUES(33,'Full English','[{"name":"cumberland sausages 25kg","amount":70,"allergens":"None","calories":"0.00"},{"name":"free range eggs tray of 30","amount":50,"allergens":"egg","calories":"0.00"},{"name":"baked beans 26kg catering tin","amount":70,"allergens":"None","calories":"0.00"},{"name":"sliced mushrooms 1kg","amount":50,"allergens":"None","calories":"0.00"},{"name":"back bacon unsmoked 2kg","amount":50,"allergens":"None","calories":"0.00"},{"name":"frozen hashbrowns 15kg","amount":50,"allergens":"None","calories":"0.00"},{"name":"crushed tomatoes 25kg","amount":30,"allergens":"None","calories":"0.00"}]','egg',0.0,12.5,2,'meals','2025-05-27 21:55:22',NULL,0);
INSERT INTO meals VALUES(35,'Beans ON Toast','[{"name":"baked beans 26kg catering tin","amount":250,"allergens":"None","calories":"0.00"},{"name":"brown bread loaf","amount":75,"allergens":"gluten","calories":"0.00"}]','gluten',0.0,7.5,2,'meals','2025-06-07 07:20:41',NULL,0);
INSERT INTO meals VALUES(36,'Sausage Sandwich','[{"name":"cumberland sausages 25kg","amount":200,"allergens":"None","calories":"0.00"},{"name":"brown bread loaf","amount":75,"allergens":"gluten","calories":"0.00"}]','gluten',0.0,7.5,2,'meals','2025-06-07 07:22:09',NULL,0);
INSERT INTO meals VALUES(40,'Chicken Parmesan','[{"name":"chicken","amount":100,"allergens":"None","calories":"150.00"}]','None',150.0,10.0,2,'meals','2025-07-24 20:06:51',NULL,0);
INSERT INTO meals VALUES(42,'Strawberry Cake','[{"name":"cake","amount":150,"allergens":"None","calories":"0.00"}]','None',0.0,5.5,2,'desserts','2025-07-24 20:17:42',NULL,0);
INSERT INTO meals VALUES(43,'Tiramisu','[{"name":"e","amount":123,"allergens":"None","calories":"0.00"}]','None',0.0,5.0,2,'desserts','2025-07-24 20:18:27',NULL,0);
INSERT INTO meals VALUES(44,'Sticky Toffee Pudding','[{"name":"w","amount":123,"allergens":"None","calories":"0.00"}]','None',0.0,5.5,2,'desserts','2025-07-24 20:19:19',NULL,0);
INSERT INTO meals VALUES(45,'Banoffee Pie','[{"name":"d","amount":123,"allergens":"None","calories":"0.00"}]','None',0.0,6.0,2,'desserts','2025-07-24 20:19:59',NULL,0);
INSERT INTO meals VALUES(46,'Carrot Cake','[{"name":"w","amount":123,"allergens":"None","calories":"0.00"}]','None',0.0,4.5,2,'desserts','2025-07-24 20:21:36',NULL,0);
INSERT INTO meals VALUES(47,'Vanilla Cheesecake','[{"name":"w","amount":123,"allergens":"None","calories":"0.00"}]','None',0.0,5.0,2,'desserts','2025-07-24 20:24:25',NULL,0);
INSERT INTO meals VALUES(48,'ss','[{"name":"ss","amount":1,"allergens":"None","calories":"0.00"}]','None',0.0,1.0,2,'Breakfast','2025-08-07 18:27:32',NULL,0);
INSERT INTO meals VALUES(49,'Egg Royale','[{"name":"hollandaise sauce","amount":100,"allergens":"None","calories":"0.00"},{"name":"classic salmon","amount":100,"allergens":"None","calories":"0.00"},{"name":"poached egg","amount":100,"allergens":"None","calories":"0.00"},{"name":"sesame seeded buns","amount":100,"allergens":"None","calories":"0.00"}]','None',0.0,9.5,2,'Breakfast','2025-08-14 09:20:35',NULL,0);
INSERT INTO meals VALUES(50,'Red Bull','[{"name":"red bull energy drink 11 1149","amount":100,"allergens":"None","calories":"0.00"}]','None',0.0,5.0,2,'Drinks','2025-08-15 06:44:10',NULL,0);
CREATE TABLE stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient TEXT NOT NULL,
    price REAL DEFAULT 0,                       -- ✅ price per unit (kg, liter, etc.)
    supplier_id INTEGER,                        -- ✅ link to suppliers table
    quantity REAL DEFAULT 0,                    -- ✅ current stock quantity
    allergens TEXT DEFAULT 'None',              -- ✅ allergens info (e.g., 'Eggs, Milk')
    calories_per_100g REAL DEFAULT 0,           -- ✅ kcal per 100g (or per unit)
    waste_flag INTEGER DEFAULT 0,               -- ✅ 0 = normal, 1 = flagged for waste
    expiry_date TEXT,                           -- ✅ expiry date for the stock item
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, price_per_unit REAL GENERATED ALWAYS AS (price) VIRTUAL, unit TEXT DEFAULT 'g', minimum_level INTEGER DEFAULT 10, quantity_in_grams REAL, type TEXT DEFAULT 'ingredient', category TEXT, portions_left INTEGER DEFAULT 0, name TEXT,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL
);
INSERT INTO stock VALUES(878,'CocaCola 24x330ml 2 1099',21.98000000000000042,NULL,-9.0,'None',0.0,0,NULL,'2025-06-25 13:12:56','g',10,NULL,'drink','General',0,NULL);
INSERT INTO stock VALUES(879,'Red Bull Energy Drink 11 1149',4.200000000000000177,NULL,-4.0,'None',0.0,0,NULL,'2025-06-25 13:12:56','g',10,NULL,'drink','General',0,NULL);
INSERT INTO stock VALUES(880,'Still Water 12x50ml',14.90000000000000035,NULL,1.0,'None',0.0,0,NULL,'2025-06-25 13:12:56','g',10,NULL,'drink','General',0,NULL);
INSERT INTO stock VALUES(881,'Appletiser Sparkling 2',15.25,NULL,972.0,'None',0.0,0,NULL,'2025-06-25 13:12:56','g',10,NULL,'drink','General',0,NULL);
INSERT INTO stock VALUES(882,'FeverTree Tonic 11 1525',15.25,NULL,-3.0,'None',0.0,0,NULL,'2025-06-25 13:12:56','g',10,NULL,'drink','General',0,NULL);
INSERT INTO stock VALUES(884,'crushed tomatoes 25kg',2.200000000000000178,NULL,46340.0,'None',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(885,'plain flour 15kg',4.0,NULL,15000.0,'gluten',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(886,'free range eggs tray of 30',3.600000000000000088,NULL,-6098.0,'egg',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(887,'baguettes 20 x 18 be',8.800000000000000711,NULL,20.0,'None',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(888,'carrot cake 12kg',4.990000000000000213,NULL,12000.0,'None',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(889,'chocolate fudge cake 12ptn',11.0,NULL,24.0,'None',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(890,'vanilla ice cream 4l',3.600000000000000088,NULL,4000.0,'milk',0.0,0,NULL,'2025-06-25 13:15:51','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(891,'cumberland sausages 25kg',8.75,NULL,13660.0,'None',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(894,'sliced mushrooms 1kg',3.399999999999999912,NULL,-4100.0,'None',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(895,'back bacon unsmoked 2kg',7.990000000000000213,NULL,-4100.0,'None',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(896,'frozen hashbrowns 15kg',2.5,NULL,8900.0,'None',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(897,'white bread loaf',2.0,NULL,2.0,'gluten',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(898,'brown bread loaf',2.100000000000000088,NULL,-2923.0,'gluten',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(899,'baked beans 26kg catering tin',3.299999999999999823,NULL,11210.0,'None',0.0,0,NULL,'2025-06-25 13:16:41','g',10,NULL,'ingredient',NULL,0,NULL);
INSERT INTO stock VALUES(900,'chicken',2.990000000000000213,NULL,400.0,'none',150.0,0,NULL,'2025-07-24 20:05:36','g',10,NULL,'ingredient',NULL,0,NULL);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL, -- Per unit price (clean name as 'price')
  total_price REAL NOT NULL,
  table_number TEXT DEFAULT 'Takeaway',
  order_status TEXT DEFAULT 'Pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid INTEGER DEFAULT 0,
  batch_id TEXT,
  category TEXT DEFAULT 'meals'
, order_type TEXT DEFAULT 'dine-in', note TEXT, special_requests TEXT, options TEXT, price_per_unit REAL);
INSERT INTO orders VALUES(88,'Full English',2,12.99000000000000021,25.98000000000000042,'delivery','Pending','2025-06-05 19:11:36',0,'8928b677-ecb1-4c73-b268-1a7496b128aa','meals','delivery',NULL,NULL,NULL,NULL);
INSERT INTO orders VALUES(89,'Full English',2,12.99000000000000021,25.98000000000000042,'delivery','Pending','2025-06-05 19:49:10',0,'4352a70c-b7f0-40e1-af15-42c01003a68e','meals','delivery',NULL,NULL,NULL,NULL);
INSERT INTO orders VALUES(301,'Ww',1,1.0,1.0,'Table 1','Pending','2025-08-14 05:07:05',1,'f28b920d-ffd4-49f4-9839-4c29c9a03a93','misc','dine-in',NULL,NULL,NULL,NULL);
INSERT INTO orders VALUES(307,'Full English',1,12.5,12.5,'5','Pending','2025-08-14 06:13:51',0,'9cc9e805-0c26-4504-b7a4-2f91e06fed7a','meals','dine-in','',NULL,'White Bread',NULL);
INSERT INTO orders VALUES(308,'Beans ON Toast',1,7.5,7.5,'5','Pending','2025-08-14 06:13:51',0,'9cc9e805-0c26-4504-b7a4-2f91e06fed7a','meals','dine-in','Brown',NULL,'',NULL);
INSERT INTO orders VALUES(309,'Sausage Sandwich',1,7.5,7.5,'5','Pending','2025-08-14 06:13:51',0,'9cc9e805-0c26-4504-b7a4-2f91e06fed7a','meals','dine-in','1 sausage',NULL,'',NULL);
INSERT INTO orders VALUES(310,'Chicken Parmesan',1,10.0,10.0,'5','Pending','2025-08-14 06:13:51',0,'9cc9e805-0c26-4504-b7a4-2f91e06fed7a','meals','dine-in','no cheese',NULL,'',NULL);
INSERT INTO orders VALUES(313,'Beans ON Toast',1,7.5,7.5,'4','Pending','2025-08-15 06:40:37',0,'4dd2bfbe-f734-4e79-8d0a-7aa58051b717','meals','dine-in','',NULL,'',NULL);
INSERT INTO orders VALUES(314,'Sausage Sandwich',1,7.5,7.5,'4','Pending','2025-08-15 06:40:37',0,'4dd2bfbe-f734-4e79-8d0a-7aa58051b717','meals','dine-in','no butter',NULL,'',NULL);
INSERT INTO orders VALUES(315,'Chicken Parmesan',1,10.0,10.0,'4','Pending','2025-08-15 06:40:37',0,'4dd2bfbe-f734-4e79-8d0a-7aa58051b717','meals','dine-in','no parmesan',NULL,'',NULL);
INSERT INTO orders VALUES(316,'Beans ON Toast',1,7.5,7.5,'4','Pending','2025-08-15 06:40:37',0,'4dd2bfbe-f734-4e79-8d0a-7aa58051b717','meals','dine-in','no butter',NULL,'',NULL);
INSERT INTO orders VALUES(317,'Beans ON Toast',2,7.5,15.0,'4','Pending','2025-08-15 06:44:39',0,'76f13213-d0c7-4c8a-a892-c6ebbeeec726','meals','dine-in','',NULL,'',NULL);
INSERT INTO orders VALUES(318,'Sausage Sandwich',1,7.5,7.5,'4','Pending','2025-08-15 06:44:39',0,'76f13213-d0c7-4c8a-a892-c6ebbeeec726','meals','dine-in','no butter',NULL,'',NULL);
INSERT INTO orders VALUES(319,'Chicken Parmesan',1,10.0,10.0,'4','Pending','2025-08-15 06:44:39',0,'76f13213-d0c7-4c8a-a892-c6ebbeeec726','meals','dine-in','no parmesan',NULL,'',NULL);
INSERT INTO orders VALUES(320,'Red Bull',1,5.0,5.0,'4','Pending','2025-08-15 06:44:39',0,'76f13213-d0c7-4c8a-a892-c6ebbeeec726','Drinks','dine-in','',NULL,'',NULL);
CREATE TABLE meal_ingredients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id INTEGER NOT NULL,
    ingredient TEXT NOT NULL,
    quantity REAL NOT NULL,
    FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE
);
INSERT INTO meal_ingredients VALUES(29,33,'cumberland sausages 25kg',70.0);
INSERT INTO meal_ingredients VALUES(30,33,'free range eggs tray of 30',50.0);
INSERT INTO meal_ingredients VALUES(31,33,'baked beans 26kg catering tin',70.0);
INSERT INTO meal_ingredients VALUES(32,33,'sliced mushrooms 1kg',50.0);
INSERT INTO meal_ingredients VALUES(33,33,'back bacon unsmoked 2kg',50.0);
INSERT INTO meal_ingredients VALUES(34,33,'frozen hashbrowns 15kg',50.0);
INSERT INTO meal_ingredients VALUES(35,33,'crushed tomatoes 25kg',30.0);
INSERT INTO meal_ingredients VALUES(37,35,'baked beans 26kg catering tin',250.0);
INSERT INTO meal_ingredients VALUES(38,35,'brown bread loaf',75.0);
INSERT INTO meal_ingredients VALUES(39,36,'cumberland sausages 25kg',200.0);
INSERT INTO meal_ingredients VALUES(40,36,'brown bread loaf',75.0);
INSERT INTO meal_ingredients VALUES(45,40,'chicken',100.0);
INSERT INTO meal_ingredients VALUES(47,42,'cake',150.0);
INSERT INTO meal_ingredients VALUES(48,43,'e',123.0);
INSERT INTO meal_ingredients VALUES(49,44,'w',123.0);
INSERT INTO meal_ingredients VALUES(50,45,'d',123.0);
INSERT INTO meal_ingredients VALUES(51,46,'w',123.0);
INSERT INTO meal_ingredients VALUES(52,47,'w',123.0);
INSERT INTO meal_ingredients VALUES(53,48,'ss',1.0);
INSERT INTO meal_ingredients VALUES(54,49,'hollandaise sauce',100.0);
INSERT INTO meal_ingredients VALUES(55,49,'classic salmon',100.0);
INSERT INTO meal_ingredients VALUES(56,49,'poached egg',100.0);
INSERT INTO meal_ingredients VALUES(57,49,'sesame seeded buns',100.0);
INSERT INTO meal_ingredients VALUES(58,50,'red bull energy drink 11 1149',100.0);
CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER,
    item_type TEXT CHECK (item_type IN ('meal', 'drink', 'dessert')),
    item_id INTEGER,
    quantity INTEGER DEFAULT 1,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE TABLE stock_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient TEXT,
    quantity REAL,
    alert_message TEXT,
    created_at TEXT
);
CREATE TABLE ordering_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT,
  supplier TEXT,
  ingredient TEXT,
  quantity INTEGER,
  price REAL
);
CREATE TABLE drinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  quantity REAL,
  price REAL,
  supplier_id INTEGER
);
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  number_of_people INTEGER NOT NULL,
  table_number TEXT NOT NULL,
  booking_time TEXT NOT NULL,
  status TEXT DEFAULT 'booked'
, updated_at TEXT);
INSERT INTO bookings VALUES(2,'Maks','0782323245',6,'5','2025-06-05T12:00','arrived','2025-06-05 09:09:42');
CREATE TABLE delivery_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  customer_name TEXT,
  items TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE kitchen_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  is_paused INTEGER DEFAULT 0
);
INSERT INTO kitchen_settings VALUES(1,0);
CREATE TABLE kitchen_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  is_paused INTEGER DEFAULT 0
);
INSERT INTO kitchen_status VALUES(1,0);
CREATE TABLE menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  json_data TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient TEXT NOT NULL,
  quantity_sold REAL NOT NULL,
  type TEXT DEFAULT 'ingredient',
  sold_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE table_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  seats INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  status TEXT DEFAULT 'free'
, shape TEXT DEFAULT 'square', zone TEXT DEFAULT 'Main', linked_table_id INTEGER);
INSERT INTO table_map VALUES(67,'Table 1',2,88,56.265625,'occupied','circle','Main',NULL);
INSERT INTO table_map VALUES(68,'Table 2',2,248,55.25,'occupied','square','Main',NULL);
INSERT INTO table_map VALUES(69,'Table 3',2,382,60.25,'occupied','rectangle','Main',NULL);
INSERT INTO table_map VALUES(71,'Table 4',4,600,67.75,'free','square','Main',NULL);
INSERT INTO table_map VALUES(91,'table 5',6,743,50.75,'free','circle','Main',NULL);
INSERT INTO table_map VALUES(92,'table 6',8,897,47.265625,'free','circle','Main',NULL);
INSERT INTO table_map VALUES(93,'table 7',6,1084,50.265625,'free','square','Main',NULL);
INSERT INTO table_map VALUES(94,'table 8',4,50,241.265625,'free','rectangle','Main',NULL);
INSERT INTO table_map VALUES(95,'table 9',10,239,225.265625,'free','circle','Main',NULL);
INSERT INTO table_map VALUES(96,'table 10',12,402,228.75,'free','circle','Main',NULL);
INSERT INTO table_map VALUES(97,'table 11',4,570,232.75,'free','rectangle','Main',NULL);
INSERT INTO table_map VALUES(98,'table 12',4,761,220.265625,'free','square','Main',NULL);
INSERT INTO table_map VALUES(99,'table 13',4,921,230.265625,'free','rectangle','Main',NULL);
INSERT INTO table_map VALUES(100,'table 14',4,1123,223.265625,'free','square','Main',NULL);
INSERT INTO table_map VALUES(101,'table 15',4,42,43.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(102,'table 16',8,215,45.265625,'free','circle','Terrace',NULL);
INSERT INTO table_map VALUES(103,'table 17',10,382,41.265625,'free','circle','Terrace',NULL);
INSERT INTO table_map VALUES(104,'table 18',12,559,45.265625,'free','circle','Terrace',NULL);
INSERT INTO table_map VALUES(105,'table 19',4,738,65.265625,'free','rectangle','Terrace',NULL);
INSERT INTO table_map VALUES(106,'table 20',4,953,58.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(107,'table 21',8,1128,62.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(108,'table 22',4,43,218.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(109,'table 23',8,225,224.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(110,'table 24',8,381,225.265625,'free','circle','Terrace',NULL);
INSERT INTO table_map VALUES(111,'table 25',8,543,235.265625,'free','rectangle','Terrace',NULL);
INSERT INTO table_map VALUES(112,'table 26',8,750,235.265625,'free','rectangle','Terrace',NULL);
INSERT INTO table_map VALUES(113,'table 27',4,955,234.265625,'free','square','Terrace',NULL);
INSERT INTO table_map VALUES(114,'table 28',8,1120,236.265625,'free','rectangle','Terrace',NULL);
INSERT INTO table_map VALUES(115,'table 29',6,32,40.265625,'free','circle','Garden',NULL);
INSERT INTO table_map VALUES(116,'table 30',8,200,55.265625,'free','rectangle','Garden',NULL);
INSERT INTO table_map VALUES(117,'table 31',8,395,53.265625,'free','rectangle','Garden',NULL);
INSERT INTO table_map VALUES(118,'table 32',6,565,43.25,'free','square','Garden',NULL);
INSERT INTO table_map VALUES(119,'table 33',8,749,50.265625,'free','rectangle','Garden',NULL);
INSERT INTO table_map VALUES(120,'table 34',8,953,43.265625,'free','circle','Garden',NULL);
INSERT INTO table_map VALUES(121,'table 35',4,1118,41.265625,'free','square','Garden',NULL);
INSERT INTO table_map VALUES(122,'table 36',10,22,223.265625,'free','circle','Garden',NULL);
INSERT INTO table_map VALUES(123,'table 37',4,181,237.265625,'free','rectangle','Garden',NULL);
INSERT INTO table_map VALUES(124,'table 38',6,372,232.265625,'free','circle','Garden',NULL);
INSERT INTO table_map VALUES(125,'table 39',6,539,232.265625,'free','square','Garden',NULL);
INSERT INTO table_map VALUES(126,'table 40',8,748,241.265625,'free','square','Garden',NULL);
INSERT INTO table_map VALUES(127,'table 41',12,925,237.265625,'free','circle','Garden',NULL);
INSERT INTO table_map VALUES(128,'table 42',8,1102,245.265625,'free','rectangle','Garden',NULL);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('tables',5941);
INSERT INTO sqlite_sequence VALUES('users',2);
INSERT INTO sqlite_sequence VALUES('checklists',4);
INSERT INTO sqlite_sequence VALUES('appliances',2);
INSERT INTO sqlite_sequence VALUES('supplier_prices',253);
INSERT INTO sqlite_sequence VALUES('suppliers',2);
INSERT INTO sqlite_sequence VALUES('prepped_items',7);
INSERT INTO sqlite_sequence VALUES('reports',14);
INSERT INTO sqlite_sequence VALUES('meal_prepped_ingredients',1);
INSERT INTO sqlite_sequence VALUES('meals',50);
INSERT INTO sqlite_sequence VALUES('stock',900);
INSERT INTO sqlite_sequence VALUES('orders',320);
INSERT INTO sqlite_sequence VALUES('drink_orders',23);
INSERT INTO sqlite_sequence VALUES('meal_ingredients',58);
INSERT INTO sqlite_sequence VALUES('bookings',2);
INSERT INTO sqlite_sequence VALUES('kitchen_settings',1);
INSERT INTO sqlite_sequence VALUES('kitchen_status',1);
INSERT INTO sqlite_sequence VALUES('table_map',128);
INSERT INTO sqlite_sequence VALUES('categories',11);
CREATE UNIQUE INDEX idx_stock_ingredient ON stock(ingredient);
CREATE UNIQUE INDEX idx_drinks_name ON drinks(name);
CREATE UNIQUE INDEX idx_categories_type_name ON categories(type, name);
COMMIT;
