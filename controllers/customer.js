const Customer = require("../models/Customer");
const XLSX = require("xlsx");
const fs = require("fs");

/* =========================
   CREATE CUSTOMER
========================= */
async function handleCreateCustomer(req, res) {
  try {
    const { custName, phone, companyName } = req.body;

    if (!custName || !phone) {
      return res
        .status(400)
        .json({ msg: "Customer name and phone are required" });
    }

    const phoneStr = String(phone).trim();

    const customerExists = await Customer.findOne({ phone: phoneStr });
    if (customerExists) {
      return res.status(409).json({ msg: "Customer already exists" });
    }

    const newCustomer = await Customer.create({
      custName: custName.trim(),
      phone: phoneStr,
      companyName,
      walletBalance: 0, // ✅ default wallet
    });

    res.status(201).json({
      id: newCustomer._id,
      custName: newCustomer.custName,
      phone: newCustomer.phone,
      companyName: newCustomer.companyName,
      walletBalance: newCustomer.walletBalance,
    });
  } catch (err) {
    res.status(500).json({ msg: "Internal Server Error", error: err.message });
  }
}

/* =========================
   GET ALL CUSTOMERS
========================= */
async function handleGetAllCustomer(req, res) {
  try {
    const allCustomers = await Customer.find()
      .select("custName phone companyName walletBalance")
      .lean();

    if (allCustomers.length === 0)
      return res.status(404).json({ msg: "No customers found" });

    const cleanCustomers = allCustomers.map((c) => ({
      id: c._id,
      custName: c.custName,
      phone: c.phone,
      companyName: c.companyName,
      walletBalance: c.walletBalance || 0,
    }));

    res.json(cleanCustomers);
  } catch (err) {
    res.status(500).json({ msg: "Internal Server Error", error: err.message });
  }
}

/* =========================
   SEARCH CUSTOMER
========================= */
async function handleGetCustomerByName(req, res) {
  try {
    const { q } = req.query;

    if (!q) return res.json([]);

    const customers = await Customer.find({
      custName: { $regex: q, $options: "i" },
    })
      .limit(10)
      .select("custName phone companyName walletBalance")
      .lean();

    res.json(
      customers.map((c) => ({
        id: c._id,
        custName: c.custName,
        phone: c.phone,
        companyName: c.companyName,
        walletBalance: c.walletBalance || 0,
      })),
    );
  } catch (err) {
    res.status(500).json({
      msg: "Internal Server Error",
      error: err.message,
    });
  }
}

/* =========================
   DELETE CUSTOMER
========================= */
async function handleCustomerDelete(req, res) {
  try {
    const { id } = req.params;

    const customer = await Customer.findByIdAndDelete(id);

    if (!customer) {
      return res.status(404).json({ msg: "Customer not Found" });
    }

    res.json({ msg: "Customer Deleted Successfully" });
  } catch (err) {
    res.status(500).json({ msg: "Internal Server Error", error: err.message });
  }
}

/* =========================
   UPDATE CUSTOMER
========================= */
async function handleCustomerUpdate(req, res) {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // ❌ Prevent wallet tampering (important)
    delete updateData.walletBalance;

    const updatedCustomer = await Customer.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    }).lean();

    if (!updatedCustomer) {
      return res.status(404).json({ msg: "Customer not found" });
    }

    res.json({
      id: updatedCustomer._id,
      custName: updatedCustomer.custName,
      phone: updatedCustomer.phone,
      companyName: updatedCustomer.companyName,
      walletBalance: updatedCustomer.walletBalance || 0,
    });
  } catch (err) {
    res.status(500).json({ msg: "Internal Server Error", error: err.message });
  }
}

/* =========================
   BULK UPLOAD
========================= */
async function handleBulkUploadFromExcel(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ msg: "No file uploaded" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ msg: "Excel file is empty" });
    }

    const customers = rows.map((row) => ({
      custName: String(row.custName || "").trim(),
      phone: String(row.phone || "").trim(),
      companyName: row.companyName || "Unknown",
      walletBalance: 0, // ✅ important
    }));

    const inserted = await Customer.insertMany(customers);

    fs.unlinkSync(req.file.path);

    const response = inserted.map((c) => ({
      id: c._id,
      custName: c.custName,
      phone: c.phone,
      companyName: c.companyName,
      walletBalance: c.walletBalance || 0,
    }));

    res.status(201).json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/* =========================
   ADD / UPDATE WALLET
========================= */
// async function handleUpdateWallet(req, res) {
//   try {
//     const { id } = req.params;
//     const { amount, type } = req.body;

//     if (!amount || amount <= 0) {
//       return res.status(400).json({ msg: "Amount must be greater than 0" });
//     }

//     const customer = await Customer.findById(id);

//     if (!customer) {
//       return res.status(404).json({ msg: "Customer not found" });
//     }

//     if (type === "credit") {
//       customer.walletBalance += amount;
//     } else if (type === "debit") {
//       if (customer.walletBalance < amount) {
//         return res.status(400).json({ msg: "Insufficient balance" });
//       }
//       customer.walletBalance -= amount;
//     } else {
//       return res.status(400).json({ msg: "Invalid type" });
//     }

//     await customer.save();

//     res.json({
//       msg: "Wallet updated successfully",
//       walletBalance: customer.walletBalance,
//     });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// }

/* =========================
   UPDATE WALLET
========================= */
async function handleUpdateWallet(req, res) {
  try {
    const { id } = req.params;
    const { walletBalance } = req.body;

    if (
      walletBalance === undefined ||
      isNaN(walletBalance) ||
      Number(walletBalance) < 0
    ) {
      return res.status(400).json({
        msg: "Invalid wallet balance",
      });
    }

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        msg: "Customer not found",
      });
    }

    // customer.walletBalance = Number(walletBalance);
    customer.walletBalance = Number(walletBalance.toFixed(2));

    await customer.save();

    res.json({
      msg: "Wallet updated successfully",
      walletBalance: customer.walletBalance,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
}

module.exports = {
  handleGetAllCustomer,
  handleCreateCustomer,
  handleUpdateWallet,
  handleGetCustomerByName,
  handleCustomerDelete,
  handleCustomerUpdate,
  handleBulkUploadFromExcel,
};
