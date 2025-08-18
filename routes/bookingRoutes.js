// backend/routes/bookingRoutes.js
const express = require('express');
const router = express.Router();
const db = require('../dbSqliteCompat');

// Create a booking
router.post('/', (req, res) => {
  const { customer_name, phone, number_of_people, table_number, booking_time } = req.body;

  if (!customer_name || !booking_time || !table_number) {
    return res.status(400).json({ error: 'Customer name, table number, and booking time are required.' });
  }

  const query = `
    INSERT INTO bookings (customer_name, phone, number_of_people, table_number, booking_time, status)
    VALUES (?, ?, ?, ?, ?, 'booked')
  `;

  db.run(
    query,
    [customer_name, phone, number_of_people || 1, table_number, booking_time],
    function (err) {
      if (err) {
        console.error('❌ Error saving booking:', err.message);
        return res.status(500).json({ error: 'Failed to save booking.' });
      }
      res.status(201).json({ message: '✅ Booking created.', id: this.lastID });
    }
  );
});

// Get all bookings
router.get('/', (req, res) => {
  pool.query('SELECT * FROM bookings ORDER BY booking_time ASC', [], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching bookings:', err.message);
      return res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
    res.json(rows);
  });
});

// Mark booking as arrived
router.put('/arrived/:id', (req, res) => {
  const { id } = req.params;

  db.run(
    'UPDATE bookings SET status = "arrived", updated_at = datetime("now") WHERE id = ?',
    [id],
    function (err) {
      if (err) {
        console.error('❌ Error updating booking status:', err.message);
        return res.status(500).json({ error: 'Failed to update booking status.' });
      }
      res.json({ message: '✅ Booking marked as arrived.' });
    }
  );
});

// Delete a booking
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  db.run('DELETE FROM bookings WHERE id = ?', [id], function (err) {
    if (err) {
      console.error('❌ Error deleting booking:', err.message);
      return res.status(500).json({ error: 'Failed to delete booking.' });
    }
    res.json({ message: '✅ Booking deleted.' });
  });
});

module.exports = router;
