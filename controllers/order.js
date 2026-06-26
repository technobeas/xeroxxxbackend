const Order = require("../models/Order");
const Customer = require("../models/Customer");
const Product = require("../models/Product");
const Revenue = require("../models/Revenue");
const Payment = require("../models/Payment");
const mongoose = require("mongoose");

/* =========================
   CREATE ORDER (WALLET SUPPORT)
========================= */
async function handleCreateOrder(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const { signature } = req.body;
  try {
    const {
      customerId,
      walletUsed = 0,
      items,
      subTotal,
      gstPercent = 18,
      gstAmount,
      extraCharges = 0,
      discount = 0,
      totalAmount,
      paidAmount = 0,
    } = req.body;

    /* =========================
       CUSTOMER
    ========================= */
    const customer = await Customer.findById(customerId).session(session);
    if (!customer) throw new Error("Customer not found");

    /* =========================
       ITEMS + STOCK
    ========================= */
    const finalItems = [];

    for (const i of items) {
      const product = await Product.findById(i.product).session(session);

      if (!product) throw new Error("Product not found");

      if (product.trackStock) {
        if (product.stock < i.qty) {
          throw new Error(`Insufficient stock for ${product.name}`);
        }

        product.stock -= i.qty;
        await product.save({ session });
      }

      finalItems.push({
        product: product._id,
        name: i.name || product.name,
        qty: i.qty,
        price: Number(i.price),
        total: Number(i.total),
      });
    }

    /* =========================
       WALLET + ADVANCE LOGIC
    ========================= */

    let safeWalletUsed = Math.max(0, walletUsed);
    safeWalletUsed = Math.min(safeWalletUsed, customer.walletBalance);

    // deduct wallet
    customer.walletBalance -= safeWalletUsed;

    // total paid (cash + wallet)
    let totalPaid = Number(paidAmount) + safeWalletUsed;

    let advanceAmount = 0;

    // ✅ ADVANCE LOGIC (FIXED)
    if (totalPaid > totalAmount) {
      advanceAmount = totalPaid - totalAmount;

      // add to wallet
      customer.walletBalance += advanceAmount;

      totalPaid = totalAmount;
    }

    await customer.save({ session });

    /* =========================
       ORDER CALCULATION
    ========================= */

    const balanceAmount = Number(totalAmount) - totalPaid;

    let status = "pending";
    if (balanceAmount <= 0) status = "paid";
    else if (totalPaid > 0) status = "partial";

    /* =========================
       CREATE ORDER
    ========================= */

    const order = await Order.create(
      [
        {
          customer: customerId,
          customerName: customer.custName,
          items: finalItems,

          subTotal: Number(subTotal),
          gstPercent: Number(gstPercent),
          gstAmount: Number(gstAmount),

          extraCharges: Number(extraCharges),
          discount: Number(discount),

          totalAmount: Number(totalAmount),

          paidAmount: totalPaid,
          balanceAmount,
          status,
          signature: signature || null,
          walletUsed: safeWalletUsed,

          // ✅ IMPORTANT
          walletAdded: advanceAmount,
          advanceAmount: advanceAmount,
        },
      ],
      { session },
    );

    /* =========================
       PAYMENT + REVENUE
    ========================= */

    if (totalPaid > 0) {
      await Payment.create(
        [
          {
            order: order[0]._id,
            customer: customerId,
            amount: totalPaid,
            paymentMode: "mixed",
          },
        ],
        { session },
      );

      await Revenue.create(
        [
          {
            source: "order",
            order: order[0]._id,
            amount: totalPaid,
          },
        ],
        { session },
      );
    }

    await session.commitTransaction();
    session.endSession();

    res.json(order[0]);
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    console.error(err);
    res.status(400).json({ msg: err.message });
  }
}
/* =========================
   PAY ORDER (WITH WALLET ADD)
========================= */
async function handleOrderPay(req, res) {
  try {
    const { amount } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ msg: "Order not found" });

    const customer = await Customer.findById(order.customer);

    order.paidAmount += amount;

    let walletAdded = 0;

    if (order.paidAmount > order.totalAmount) {
      walletAdded = order.paidAmount - order.totalAmount;

      customer.walletBalance += walletAdded;

      order.walletAdded = (order.walletAdded || 0) + walletAdded;
      order.paidAmount = order.totalAmount;
    }

    order.balanceAmount = order.totalAmount - order.paidAmount;

    order.status =
      order.balanceAmount <= 0
        ? "paid"
        : order.paidAmount > 0
          ? "partial"
          : "pending";

    await order.save();
    await customer.save();

    await Payment.create({
      order: order._id,
      customer: order.customer,
      amount,
      paymentMode: "cash",
    });

    await Revenue.create({
      source: "order",
      order: order._id,
      amount,
    });

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: err.message });
  }
}

async function handleEditOrder(req, res) {
  try {
    const {
      items,
      gstApplied,
      totalAmount: manualTotal,
      paidAmount,
      extraCharges = 0,
      discount = 0,
    } = req.body;

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ msg: "Order not found" });

    /* ===============================
       1️⃣ RESTORE OLD STOCK
    =============================== */
    for (const oldItem of order.items) {
      const product = await Product.findById(oldItem.product);
      if (product && product.trackStock) {
        product.stock += oldItem.qty;
        await product.save();
      }
    }

    /* ===============================
       2️⃣ VALIDATE & DEDUCT NEW STOCK
    =============================== */
    const populatedItems = [];

    for (const i of items) {
      const product = await Product.findById(i.product);
      if (!product) {
        return res.status(404).json({ msg: "Product not found" });
      }

      if (product.trackStock) {
        if (product.stock < i.qty) {
          return res.status(400).json({
            msg: `Insufficient stock for ${product.name}`,
          });
        }

        product.stock -= i.qty;
        await product.save();
      }

      populatedItems.push({
        product: product._id,
        name: product.name,
        qty: i.qty,
        price: Number(i.price),
        total: Number(i.price) * i.qty,
      });
    }

    /* ===============================
       3️⃣ TOTALS
    =============================== */
    const newSubTotal = populatedItems.reduce((s, i) => s + i.total, 0);
    const gstAmount = gstApplied ? newSubTotal * 0.18 : 0;

    let finalTotal;

    if (typeof manualTotal === "number") {
      order.extraCharges = Number(extraCharges);
      order.discount = Number(discount);
      finalTotal = manualTotal;
    } else {
      finalTotal =
        newSubTotal +
        gstAmount +
        (order.extraCharges || 0) -
        (order.discount || 0);
    }

    // const balanceAmount = finalTotal - order.paidAmount;

    /* ===============================
       4️⃣ SAVE ORDER
    =============================== */
    order.items = populatedItems;
    order.subTotal = newSubTotal;
    order.gstAmount = gstAmount;
    order.gstPercent = gstApplied ? 18 : 0;
    order.totalAmount = finalTotal;
    // order.balanceAmount = balanceAmount;

    // order.status =
    //   balanceAmount <= 0
    //     ? "paid"
    //     : order.paidAmount > 0
    //       ? "partial"
    //       : "pending";

    if (Number(paidAmount) > finalTotal) {
      return res.status(400).json({
        msg: "Paid amount cannot be greater than Total Amount",
      });
    }

    order.paidAmount = Number(paidAmount);
    order.balanceAmount = finalTotal - order.paidAmount;

    order.status =
      order.balanceAmount <= 0
        ? "paid"
        : order.paidAmount > 0
          ? "partial"
          : "pending";

    await order.save();

    /* ===============================
   5️⃣ ADJUST REVENUE IF NEEDED
=============================== */

    // const difference = Number(paidAmount) - oldPaidAmount;

    // if (difference > 0) {
    //   await Revenue.create({
    //     source: "order",
    //     order: order._id,
    //     amount: difference,
    //   });

    //   await Payment.create({
    //     order: order._id,
    //     customer: order.customer,
    //     amount: difference,
    //     paymentMode: "edit",
    //   });
    // }

    // if (difference < 0) {
    //   await Revenue.create({
    //     source: "order",
    //     order: order._id,
    //     amount: difference, // negative value
    //   });

    //   await Payment.create({
    //     order: order._id,
    //     customer: order.customer,
    //     amount: difference, // negative value
    //     paymentMode: "edit",
    //   });
    // }

    // const oldTotalRevenue = await Revenue.aggregate([
    //   { $match: { order: order._id } },
    //   { $group: { _id: null, total: { $sum: "$amount" } } },
    // ]);

    // const alreadyRecordedRevenue = oldTotalRevenue[0]?.total || 0;

    // // If order is fully paid, revenue should match totalAmount
    // if (order.status === "paid") {
    //   const difference = order.totalAmount - alreadyRecordedRevenue;

    //   if (difference !== 0) {
    //     await Revenue.create({
    //       source: "order",
    //       order: order._id,
    //       amount: difference,
    //     });
    //   }
    // }

    /* ===============================
   5️⃣ ADJUST PAYMENT & REVENUE
=============================== */

    // Total revenue already recorded
    const revenueAgg = await Revenue.aggregate([
      { $match: { order: order._id } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]);

    const recordedRevenue = revenueAgg[0]?.total || 0;

    // Total payments already recorded
    const paymentAgg = await Payment.aggregate([
      { $match: { order: order._id } },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]);

    const recordedPayment = paymentAgg[0]?.total || 0;

    // Revenue adjustment
    const revenueDifference = order.paidAmount - recordedRevenue;

    if (revenueDifference !== 0) {
      await Revenue.create({
        source: "order",
        order: order._id,
        amount: revenueDifference,
      });
    }

    // Payment adjustment
    const paymentDifference = order.paidAmount - recordedPayment;

    if (paymentDifference !== 0) {
      await Payment.create({
        order: order._id,
        customer: order.customer,
        amount: paymentDifference,
        paymentMode: "edit",
      });
    }

    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: err.message });
  }
}

async function handleWalkinCustomer(req, res) {
  try {
    const { items, finalTotal, gstApplied } = req.body;

    if (typeof finalTotal !== "number" || finalTotal < 0) {
      return res.status(400).json({ msg: "Invalid final total" });
    }

    let subTotal = 0;

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(404).json({ msg: "Product not found" });
      }

      if (product.trackStock) {
        if (product.stock < item.qty) {
          return res.status(400).json({
            msg: `Stock insufficient for ${product.name}`,
          });
        }
        product.stock -= item.qty;
        await product.save();
      }

      subTotal += product.price * item.qty;
    }

    // 🔐 Optional sanity check (recommended)
    if (typeof finalTotal !== "number" || finalTotal < 0) {
      return res.status(400).json({ msg: "Invalid final total" });
    }

    // ✅ Save revenue using FINAL TOTAL
    await Revenue.create({
      source: "quickSale",
      amount: finalTotal,
    });

    return res.json({
      total: finalTotal,
      msg: "Quick sale completed",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ msg: err.message });
  }
}

async function handleGetOrder(req, res) {
  try {
    const orders = await Order.find()
      .populate("customer", "custName phone")
      .populate("items.product", "name")
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: err.message });
  }
}

async function handleOrderHistory(req, res) {
  try {
    const { phone, start, end } = req.query;

    const filter = {};

    // 📅 Date filter
    if (start && end) {
      filter.createdAt = {
        $gte: new Date(start),
        $lte: new Date(end),
      };
    }

    // 📞 Customer phone filter
    if (phone) {
      const customer = await Customer.findOne({ phone });
      if (!customer) return res.json([]);
      filter.customer = customer._id;
    }

    const orders = await Order.find(filter)
      .populate("customer", "custName phone")
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: err.message });
  }
}

async function handleCustomersWithBalance(req, res) {
  try {
    const orders = await Order.find({
      balanceAmount: { $gt: 0 },
      status: { $ne: "paid" },
    })
      .populate("customer", "custName phone")
      .sort({ createdAt: 1 });

    const customerMap = new Map();

    for (const order of orders) {
      // 🛑 HARD GUARDS
      if (!order.customer) continue;
      if (!order.balanceAmount || order.balanceAmount <= 0) continue;

      const customerId = String(order.customer._id);

      if (!customerMap.has(customerId)) {
        customerMap.set(customerId, {
          customerId,
          customerName: order.customer.custName || "Unknown",
          customerMobile: order.customer.phone || "-",
          balance: 0,
          orderStart: order.createdAt,
          orderEnd: order.createdAt,
          lastMessageSent: order.lastMessageSent || null,
        });
      }

      const customer = customerMap.get(customerId);

      customer.balance += Number(order.balanceAmount);

      if (order.createdAt < customer.orderStart)
        customer.orderStart = order.createdAt;

      if (order.createdAt > customer.orderEnd)
        customer.orderEnd = order.createdAt;
    }

    res.json({
      success: true,
      customers: Array.from(customerMap.values()),
    });
  } catch (err) {
    console.error("CUSTOMERS WITH BALANCE ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

async function handleWhatsAppSent(req, res) {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ msg: "orderId required" });
    }

    const order = await Order.findByIdAndUpdate(
      orderId,
      { lastMessageSent: new Date() },
      { new: true },
    );

    if (!order) {
      return res.status(404).json({ msg: "Order not found" });
    }

    res.json({ success: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: err.message });
  }
}

async function handleOrdersWithBalanceByCustomer(req, res) {
  try {
    const { customerId } = req.params;

    const orders = await Order.find({
      customer: customerId,
      balanceAmount: { $gt: 0 },
      status: { $ne: "paid" },
    }).populate("items.product", "name");

    // const formatted = orders.map((o) => ({
    //   orderId: o._id,
    //   order_date: o.createdAt,
    //   payable: o.totalAmount,
    //   balance: o.balanceAmount,
    //   items: o.items.map((i) => ({
    //     product_name: i.product?.name,
    //     quantity: i.qty,
    //     rate: i.price,
    //   })),
    // }));

    const formatted = orders.map((o) => ({
      orderId: o._id,
      order_date: o.createdAt,

      subTotal: o.subTotal,
      gstPercent: o.gstPercent,
      gstAmount: o.gstAmount,
      extraCharges: o.extraCharges,
      discount: o.discount,

      payable: o.totalAmount,
      paidAmount: o.paidAmount,
      balance: o.balanceAmount,

      signature: o.signature,

      items: o.items.map((i) => ({
        product_name: i.product?.name,
        quantity: i.qty,
        rate: i.price,
      })),
    }));

    res.json({ success: true, orders: formatted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
}
// async function handleCustomerBulkPay(req, res) {
//   try {
//     const { customerId, amount } = req.body;

//     if (!customerId || !amount || amount <= 0) {
//       return res
//         .status(400)
//         .json({ success: false, error: "Invalid parameters" });
//     }

//     let remaining = amount;

//     const orders = await Order.find({
//       customer: customerId,
//       balanceAmount: { $gt: 0 },
//       status: { $ne: "paid" },
//     }).sort({ createdAt: 1 });

//     for (const order of orders) {
//       if (remaining <= 0) break;

//       const payable = order.balanceAmount; // original balance
//       const paidNow = Math.min(payable, remaining);

//       order.paidAmount += paidNow;
//       order.balanceAmount -= paidNow;

//       order.status = order.balanceAmount <= 0 ? "paid" : "partial";

//       await order.save();

//       await Payment.create({
//         order: order._id,
//         customer: customerId,
//         amount: paidNow,
//         paymentMode: "cash",
//       });

//       await Revenue.create({
//         source: "order",
//         order: order._id,
//         amount: paidNow,
//       });

//       remaining -= paidNow; // reduce AFTER creating records
//     }

//     const totalBalance = await Order.aggregate([
//       {
//         $match: {
//           customer: new mongoose.Types.ObjectId(customerId),
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           total: { $sum: "$balanceAmount" },
//         },
//       },
//     ]);

//     res.json({
//       success: true,
//       newBalance: totalBalance[0]?.total || 0,
//     });
//   } catch (err) {
//     console.error("BULK PAY ERROR:", err);
//     res.status(500).json({ success: false, error: err.message });
//   }
// }

async function handleCustomerBulkPay(req, res) {
  try {
    const { customerId, amount } = req.body;

    if (!customerId || !amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid parameters" });
    }

    const customer = await Customer.findById(customerId);

    if (!customer) {
      return res
        .status(404)
        .json({ success: false, error: "Customer not found" });
    }

    let remaining = Number(amount);

    const orders = await Order.find({
      customer: customerId,
      balanceAmount: { $gt: 0 },
      status: { $ne: "paid" },
    }).sort({ createdAt: 1 });

    for (const order of orders) {
      if (remaining <= 0) break;

      const paidNow = Math.min(order.balanceAmount, remaining);

      order.paidAmount += paidNow;
      order.balanceAmount -= paidNow;

      order.status = order.balanceAmount <= 0 ? "paid" : "partial";

      await order.save();

      await Payment.create({
        order: order._id,
        customer: customerId,
        amount: paidNow,
        paymentMode: "cash",
      });

      await Revenue.create({
        source: "order",
        order: order._id,
        amount: paidNow,
      });

      remaining -= paidNow;
    }

    // ✅ Extra money goes to wallet
    if (remaining > 0) {
      customer.walletBalance += remaining;
      await customer.save();
    }

    const totalBalance = await Order.aggregate([
      {
        $match: {
          customer: new mongoose.Types.ObjectId(customerId),
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$balanceAmount" },
        },
      },
    ]);

    res.json({
      success: true,
      newBalance: totalBalance[0]?.total || 0,
      walletAdded: remaining,
      walletBalance: customer.walletBalance,
    });
  } catch (err) {
    console.error("BULK PAY ERROR:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
}

async function handleDeleteOrder(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { action } = req.body; // "1" | "2" | "3"

    const order = await Order.findById(req.params.id).session(session);
    if (!order) throw new Error("Order not found");

    const customer = await Customer.findById(order.customer).session(session);

    /* =========================
       RESTORE STOCK
    ========================= */
    for (const item of order.items) {
      const product = await Product.findById(item.product).session(session);

      if (product && product.trackStock) {
        product.stock += item.qty;
        await product.save({ session });
      }
    }

    /* =========================
       WALLET LOGIC (FIXED)
    ========================= */

    // ❗ IMPORTANT:
    // paidAmount already includes walletUsed
    // so NEVER add walletUsed separately

    if (action === "1") {
      // ✅ ADD TO WALLET
      customer.walletBalance += order.paidAmount;
      // customer.walletBalance -= order.walletAdded;

      await Revenue.deleteMany({ order: order._id }).session(session);
    } else if (action === "2") {
      // ✅ REFUND (REMOVE FROM REVENUE)
      // no wallet change
      // customer.walletBalance -= order.walletAdded;
      await Revenue.deleteMany({ order: order._id }).session(session);
    } else if (action === "3") {
      // ✅ DO NOTHING
      // no wallet change
      // customer.walletBalance -= order.walletAdded;
    }

    // remove advance always
    // if (order.walletAdded > 0) {
    //   customer.walletBalance -= order.walletAdded;
    // }

    // if (customer.walletBalance < 0) {
    //   customer.walletBalance = 0;
    // }

    await customer.save({ session });

    /* =========================
       DELETE ORDER
    ========================= */
    await Order.findByIdAndDelete(order._id).session(session);

    await session.commitTransaction();
    session.endSession();

    res.json({ msg: "Order deleted successfully" });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({ msg: err.message });
  }
}

module.exports = {
  handleCreateOrder,
  handleDeleteOrder,
  handleWalkinCustomer,
  handleEditOrder,
  handleOrderPay,
  handleGetOrder,
  handleOrderHistory,
  handleCustomersWithBalance,
  handleWhatsAppSent,
  handleCustomerBulkPay,
  handleOrdersWithBalanceByCustomer,
};
