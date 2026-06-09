-- Synthetic business: a small shop. Deliberately contains classic gotchas:
--   * customers.deleted_at soft delete
--   * orders.status includes 'refunded' rows that must NOT count as revenue
--   * amounts stored in integer cents
--   * a table outside the allow-list (internal_notes) to prove scoping
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE orders (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  status text NOT NULL, -- 'pending' | 'paid' | 'refunded'
  total_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id),
  sku text NOT NULL,
  quantity integer NOT NULL,
  unit_cents integer NOT NULL
);

CREATE TABLE internal_notes (
  id serial PRIMARY KEY,
  body text NOT NULL
);

INSERT INTO customers (email, name, deleted_at) VALUES
  ('a@x.com', 'Ada', NULL),
  ('b@x.com', 'Bob', NULL),
  ('c@x.com', 'Cyn', NULL),
  ('d@x.com', 'Del', now());  -- soft-deleted

INSERT INTO orders (customer_id, status, total_cents, created_at) VALUES
  (1, 'paid',     10000, '2026-05-03'),
  (1, 'paid',      5000, '2026-05-10'),
  (2, 'paid',      7500, '2026-05-15'),
  (2, 'refunded', 20000, '2026-05-16'),  -- must not count as revenue
  (3, 'pending',   3000, '2026-05-20');

INSERT INTO order_items (order_id, sku, quantity, unit_cents) VALUES
  (1, 'WIDGET', 2, 5000),
  (2, 'GADGET', 1, 5000),
  (3, 'WIDGET', 1, 7500),
  (4, 'GADGET', 4, 5000),
  (5, 'WIDGET', 1, 3000);

INSERT INTO internal_notes (body) VALUES ('secret');
