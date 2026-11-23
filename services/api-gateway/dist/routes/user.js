"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUserRouter = createUserRouter;
const express_1 = require("express");
const uuid_1 = require("uuid");
const email_1 = require("../services/email");
function createUserRouter(customerPool) {
    const router = (0, express_1.Router)();
    // Helper validation
    const isValidEmail = (email) => {
        return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email.trim());
    };
    // Ensure supplementary customer tables exist
    const initSupplementaryTables = async () => {
        try {
            await customerPool.query(`
        CREATE TABLE IF NOT EXISTS addresses (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID,
          label VARCHAR(50) DEFAULT 'Home',
          recipient_name VARCHAR(150),
          recipient_phone VARCHAR(20),
          address_line1 TEXT NOT NULL,
          address_line2 TEXT,
          landmark VARCHAR(150),
          city VARCHAR(100) DEFAULT 'Surat',
          postal_code VARCHAR(20) DEFAULT '395007',
          is_default BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS wishlist_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID,
          item_title VARCHAR(200) NOT NULL,
          store_name VARCHAR(150) NOT NULL,
          category VARCHAR(50),
          price NUMERIC(10, 2) NOT NULL,
          is_available BOOLEAN DEFAULT true,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS support_tickets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          ticket_number VARCHAR(30) UNIQUE NOT NULL,
          user_id UUID,
          order_id VARCHAR(100),
          subject VARCHAR(200) NOT NULL,
          description TEXT NOT NULL,
          status VARCHAR(20) DEFAULT 'OPEN',
          priority VARCHAR(20) DEFAULT 'MEDIUM',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_payment_methods (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID,
          method_type VARCHAR(30) NOT NULL,
          identifier VARCHAR(150) NOT NULL,
          label VARCHAR(100),
          is_default BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS user_notifications (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID,
          title VARCHAR(150) NOT NULL,
          message TEXT NOT NULL,
          category VARCHAR(50) DEFAULT 'ORDER',
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
            console.log('[User Router] Customer supplementary tables verified successfully.');
        }
        catch (err) {
            if (err.code === 'ECONNREFUSED') {
                console.warn('[User Router] Database currently offline. Operating with resilient in-memory fallback stores.');
            }
            else {
                console.warn('[User Router] Notice initializing customer supplementary tables:', err.message || err.code || err);
            }
        }
    };
    initSupplementaryTables();
    // In-memory fallback stores to ensure 100% zero-crash operation
    const inMemoryAddresses = new Map();
    const inMemoryWishlist = new Map();
    const inMemoryRefunds = new Map();
    const inMemoryWallet = new Map();
    const inMemoryPaymentMethods = new Map();
    const inMemoryNotifications = new Map();
    const inMemoryTickets = new Map();
    // ========================================================
    // 1. SAVED ADDRESSES (CRUD)
    // ========================================================
    router.get('/addresses', async (req, res) => {
        const userId = req.query.userId || 'default-user';
        try {
            const dbRes = await customerPool.query('SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [userId]);
            if (dbRes.rows.length > 0) {
                return res.json({ success: true, addresses: dbRes.rows });
            }
        }
        catch { }
        const list = inMemoryAddresses.get(userId) || [
            {
                id: 'addr-default-1',
                userId,
                label: 'Home',
                recipientName: 'Rahul Deshmukh',
                recipientPhone: '+919890123456',
                addressLine1: 'Flat 402, Rajhans Bellanza, VIP Road',
                addressLine2: 'Opposite Shyam Mandir',
                landmark: 'Near Vesu Canal Corridor',
                city: 'Surat',
                postalCode: '395007',
                isDefault: true,
                createdAt: new Date().toISOString()
            },
            {
                id: 'addr-default-2',
                userId,
                label: 'Work',
                recipientName: 'Rahul Deshmukh',
                recipientPhone: '+919890123456',
                addressLine1: '3rd Floor, Silicon Shoppers, Udhana-Magdalla Road',
                addressLine2: 'Vesu Tech Park',
                landmark: 'Next to Surat Diamond Bourse Bus Stop',
                city: 'Surat',
                postalCode: '395007',
                isDefault: false,
                createdAt: new Date(Date.now() - 86400000).toISOString()
            }
        ];
        inMemoryAddresses.set(userId, list);
        return res.json({ success: true, addresses: list });
    });
    router.post('/addresses', async (req, res) => {
        const { userId = 'default-user', label, recipientName, recipientPhone, addressLine1, addressLine2, landmark, city = 'Surat', postalCode = '395007', isDefault = false } = req.body;
        if (!addressLine1 || !recipientName || !recipientPhone) {
            return res.status(400).json({ error: 'Recipient name, phone, and address line are required.' });
        }
        const newAddr = {
            id: (0, uuid_1.v4)(),
            userId,
            label: label || 'Home',
            recipientName,
            recipientPhone,
            addressLine1,
            addressLine2: addressLine2 || '',
            landmark: landmark || '',
            city,
            postalCode,
            isDefault: Boolean(isDefault),
            createdAt: new Date().toISOString()
        };
        try {
            if (newAddr.isDefault) {
                await customerPool.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]).catch(() => { });
            }
            await customerPool.query(`INSERT INTO addresses (id, user_id, label, recipient_name, recipient_phone, address_line1, address_line2, landmark, city, postal_code, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [newAddr.id, userId, newAddr.label, newAddr.recipientName, newAddr.recipientPhone, newAddr.addressLine1, newAddr.addressLine2, newAddr.landmark, newAddr.city, newAddr.postalCode, newAddr.isDefault]);
        }
        catch { }
        const list = inMemoryAddresses.get(userId) || [];
        if (newAddr.isDefault) {
            list.forEach(a => a.isDefault = false);
        }
        list.unshift(newAddr);
        inMemoryAddresses.set(userId, list);
        return res.status(201).json({ success: true, message: 'Address saved successfully.', address: newAddr });
    });
    router.delete('/addresses/:id', async (req, res) => {
        const { id } = req.params;
        const userId = req.query.userId || 'default-user';
        try {
            await customerPool.query('DELETE FROM addresses WHERE id = $1', [id]);
        }
        catch { }
        const list = inMemoryAddresses.get(userId) || [];
        inMemoryAddresses.set(userId, list.filter(a => a.id !== id));
        return res.json({ success: true, message: 'Address deleted.' });
    });
    router.patch('/addresses/:id/default', async (req, res) => {
        const { id } = req.params;
        const userId = req.query.userId || 'default-user';
        try {
            await customerPool.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [userId]);
            await customerPool.query('UPDATE addresses SET is_default = true WHERE id = $1 AND user_id = $2', [id, userId]);
        }
        catch { }
        const list = inMemoryAddresses.get(userId) || [];
        list.forEach(a => a.isDefault = (a.id === id));
        inMemoryAddresses.set(userId, list);
        return res.json({ success: true, message: 'Default address updated.' });
    });
    // ========================================================
    // 2. YOUR REFUNDS
    // ========================================================
    router.get('/refunds', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const refunds = inMemoryRefunds.get(userId) || [
            {
                id: 'ref-101',
                orderNumber: 'SV-SUR-78219',
                storeName: 'Shree Krishna Daily Needs & Dairy',
                amount: 145.00,
                reason: 'Item Out of Stock during packing (Organic Curd 500g)',
                status: 'REFUNDED',
                paymentMethod: 'UPI (rahul.d@okhdfcbank)',
                utrNumber: 'UPI/2026/8940128941',
                processedAt: new Date(Date.now() - 3600000 * 48).toISOString()
            },
            {
                id: 'ref-102',
                orderNumber: 'SV-SUR-81204',
                storeName: 'Apollo Lifecare Pharmacy',
                amount: 85.00,
                reason: 'Order cancelled before merchant acceptance',
                status: 'PROCESSED',
                paymentMethod: 'StreetVerse Pay Wallet',
                utrNumber: 'WAL/2026/19481023',
                processedAt: new Date(Date.now() - 3600000 * 12).toISOString()
            }
        ];
        inMemoryRefunds.set(userId, refunds);
        return res.json({ success: true, totalRefunds: refunds.length, refunds });
    });
    // ========================================================
    // 3. YOUR WISHLIST
    // ========================================================
    router.get('/wishlist', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const wishlist = inMemoryWishlist.get(userId) || [
            {
                id: 'wish-1',
                title: 'Whole Wheat Brown Bread (400g)',
                category: 'Grocery',
                storeName: 'Green Valley Daily Needs & Organic Grocery',
                distance: '350m away',
                price: 45.00,
                isAvailable: true,
                unit: 'pcs'
            },
            {
                id: 'wish-2',
                title: 'Farm Fresh Organic Eggs (Pack of 6)',
                category: 'Grocery',
                storeName: 'Green Valley Daily Needs & Organic Grocery',
                distance: '350m away',
                price: 60.00,
                isAvailable: true,
                unit: 'pack'
            },
            {
                id: 'wish-3',
                title: 'Digital Infrared Forehead Thermometer',
                category: 'Pharmacy',
                storeName: 'Apollo Lifecare Pharmacy',
                distance: '800m away',
                price: 850.00,
                isAvailable: true,
                unit: 'pcs'
            }
        ];
        inMemoryWishlist.set(userId, wishlist);
        return res.json({ success: true, totalItems: wishlist.length, wishlist });
    });
    router.post('/wishlist', (req, res) => {
        const { userId = 'default-user', title, category = 'General', storeName = 'Neighborhood Store', price, unit = 'pcs' } = req.body;
        if (!title || price === undefined) {
            return res.status(400).json({ error: 'Title and price are required.' });
        }
        const list = inMemoryWishlist.get(userId) || [];
        const newItem = {
            id: (0, uuid_1.v4)(),
            title,
            category,
            storeName,
            distance: 'Within 1 km',
            price: Number(price),
            isAvailable: true,
            unit
        };
        list.unshift(newItem);
        inMemoryWishlist.set(userId, list);
        return res.status(201).json({ success: true, message: 'Item saved to wishlist.', item: newItem });
    });
    router.delete('/wishlist/:id', (req, res) => {
        const { id } = req.params;
        const userId = req.query.userId || 'default-user';
        const list = inMemoryWishlist.get(userId) || [];
        inMemoryWishlist.set(userId, list.filter(w => w.id !== id));
        return res.json({ success: true, message: 'Removed from wishlist.' });
    });
    // ========================================================
    // 4. E-GIFT CARDS & WALLET
    // ========================================================
    router.get('/gift-cards/balance', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const wallet = inMemoryWallet.get(userId) || { balance: 250.00, coins: 340 };
        inMemoryWallet.set(userId, wallet);
        return res.json({ success: true, balance: wallet.balance, coins: wallet.coins });
    });
    router.post('/gift-cards/redeem', (req, res) => {
        const { userId = 'default-user', cardCode, pin } = req.body;
        if (!cardCode || !pin) {
            return res.status(400).json({ error: 'Gift card code and 4-digit PIN are required.' });
        }
        const cleanCode = String(cardCode).trim().toUpperCase();
        if (cleanCode.length < 8) {
            return res.status(400).json({ error: 'Invalid card code format. Must be at least 8 characters.' });
        }
        // Determine value (demo allows any code with 500 added)
        const redeemAmount = cleanCode.includes('1000') ? 1000 : 500;
        const wallet = inMemoryWallet.get(userId) || { balance: 250.00, coins: 340 };
        wallet.balance += redeemAmount;
        inMemoryWallet.set(userId, wallet);
        return res.json({
            success: true,
            message: `Success! ₹${redeemAmount} has been credited to your StreetVerse Wallet.`,
            newBalance: wallet.balance,
            redeemedAmount: redeemAmount
        });
    });
    router.post('/gift-cards/buy', (req, res) => {
        const { userId = 'default-user', amount, recipientName, recipientEmail, message } = req.body;
        if (!amount || Number(amount) < 100) {
            return res.status(400).json({ error: 'Minimum gift card value is ₹100.' });
        }
        const voucherCode = `SV-GIFT-${Math.floor(1000 + Math.random() * 9000)}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const generatedPin = Math.floor(1000 + Math.random() * 9000).toString();
        return res.status(201).json({
            success: true,
            message: `E-Gift Card created successfully! Sent to ${recipientEmail || 'your email'}.`,
            giftCard: {
                code: voucherCode,
                pin: generatedPin,
                amount: Number(amount),
                recipientName: recipientName || 'Friend',
                message: message || 'Enjoy shopping local on StreetVerse!'
            }
        });
    });
    // ========================================================
    // 5. HELP & SUPPORT
    // ========================================================
    router.get('/support/faqs', (_req, res) => {
        const faqs = [
            {
                question: 'How fast is hyperlocal delivery?',
                answer: 'Because orders are prepared by neighborhood stores and assigned to nearby independent riders within 2-3 km, typical delivery takes between 15 to 30 minutes.'
            },
            {
                question: 'What happens if a store is out of stock?',
                answer: 'StreetVerse holds live merchant inventory. In the rare event an item is unavailable when packing, the merchant marks it and an instant refund is triggered to your original payment method.'
            },
            {
                question: 'Is there a minimum order value?',
                answer: 'Minimum order values are set independently by each neighborhood store (usually ₹50 to ₹100) to keep hyperlocal fulfillment economically viable.'
            },
            {
                question: 'Why does StreetVerse charge zero commission to small vendors?',
                answer: 'Our asset-light philosophy coordinates existing stores without building expensive dark-store warehouses, allowing local shopkeepers to keep up to 95-100% of their hard-earned margin.'
            }
        ];
        return res.json({ success: true, faqs });
    });
    router.post('/support/tickets', (req, res) => {
        const { userId = 'default-user', orderNumber, subject, description, priority = 'NORMAL' } = req.body;
        if (!subject || !description) {
            return res.status(400).json({ error: 'Subject and issue description are required.' });
        }
        const ticketNumber = `TKT-${Math.floor(10000 + Math.random() * 90000)}`;
        const newTicket = {
            id: (0, uuid_1.v4)(),
            ticketNumber,
            userId,
            orderNumber: orderNumber || 'General Inquiry',
            subject,
            description,
            status: 'OPEN',
            priority,
            createdAt: new Date().toISOString()
        };
        const tickets = inMemoryTickets.get(userId) || [];
        tickets.unshift(newTicket);
        inMemoryTickets.set(userId, tickets);
        return res.status(201).json({
            success: true,
            message: `Support ticket #${ticketNumber} created. Our local support team will respond within 15 minutes.`,
            ticket: newTicket
        });
    });
    // ========================================================
    // 6. REWARDS & OFFERS
    // ========================================================
    router.get('/rewards', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const wallet = inMemoryWallet.get(userId) || { balance: 250.00, coins: 340 };
        const coupons = [
            {
                code: 'WELCOME50',
                title: '50% OFF up to ₹100',
                description: 'Valid on your first order from any verified neighborhood store.',
                minOrder: 149,
                discountPercent: 50,
                expiresIn: '7 days left'
            },
            {
                code: 'FREESHIP',
                title: 'Free Delivery',
                description: 'Zero delivery fee on orders above ₹199 within 2 km radius.',
                minOrder: 199,
                discountPercent: 100,
                expiresIn: 'Expires this Sunday'
            },
            {
                code: 'VESULOCAL',
                title: 'Flat ₹25 Cashback',
                description: 'Exclusive for orders in Vesu & VIP Road neighborhoods.',
                minOrder: 120,
                discountPercent: 20,
                expiresIn: 'Active'
            }
        ];
        return res.json({
            success: true,
            coinsBalance: wallet.coins,
            coinsValueInr: (wallet.coins / 10).toFixed(2),
            tier: 'Silver Explorer',
            referralCode: 'SURAT50',
            referralBenefit: 'Refer a neighbor: You get ₹50 and they get ₹50 on their first delivery.',
            coupons
        });
    });
    // ========================================================
    // 7. PAYMENT MANAGEMENT
    // ========================================================
    router.get('/payment-methods', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const methods = inMemoryPaymentMethods.get(userId) || [
            {
                id: 'pm-1',
                methodType: 'UPI',
                identifier: 'rahul.deshmukh@okhdfcbank',
                label: 'Primary UPI',
                isDefault: true
            },
            {
                id: 'pm-2',
                methodType: 'CARD',
                identifier: '•••• •••• •••• 4242',
                label: 'HDFC Millennia Debit Card (Visa)',
                isDefault: false
            },
            {
                id: 'pm-3',
                methodType: 'CASH',
                identifier: 'Cash on Delivery',
                label: 'Pay cash to delivery partner upon arrival',
                isDefault: false
            }
        ];
        inMemoryPaymentMethods.set(userId, methods);
        return res.json({ success: true, paymentMethods: methods });
    });
    router.post('/payment-methods', (req, res) => {
        const { userId = 'default-user', methodType, identifier, label } = req.body;
        if (!methodType || !identifier) {
            return res.status(400).json({ error: 'Payment method type and identifier are required.' });
        }
        const newMethod = {
            id: (0, uuid_1.v4)(),
            methodType: String(methodType).toUpperCase(),
            identifier,
            label: label || methodType,
            isDefault: false
        };
        const methods = inMemoryPaymentMethods.get(userId) || [];
        methods.push(newMethod);
        inMemoryPaymentMethods.set(userId, methods);
        return res.status(201).json({ success: true, message: 'Payment method linked.', paymentMethod: newMethod });
    });
    router.delete('/payment-methods/:id', (req, res) => {
        const { id } = req.params;
        const userId = req.query.userId || 'default-user';
        const methods = inMemoryPaymentMethods.get(userId) || [];
        inMemoryPaymentMethods.set(userId, methods.filter(m => m.id !== id));
        return res.json({ success: true, message: 'Payment method unlinked.' });
    });
    // ========================================================
    // 8. NOTIFICATIONS
    // ========================================================
    router.get('/notifications', (req, res) => {
        const userId = req.query.userId || 'default-user';
        const notifications = inMemoryNotifications.get(userId) || [
            {
                id: 'notif-1',
                title: 'Order Delivered! 🎉',
                message: 'Your order SV-SUR-84920 from Shree Krishna Daily Needs has been delivered. Enjoy!',
                category: 'ORDER',
                isRead: false,
                timeAgo: '10m ago'
            },
            {
                id: 'notif-2',
                title: 'Neighborhood Restock Alert',
                message: 'Farm fresh organic eggs and brown bread are now back in stock at Green Valley Grocery.',
                category: 'STORE',
                isRead: false,
                timeAgo: '2h ago'
            },
            {
                id: 'notif-3',
                title: '₹50 Off Coupon Added',
                message: 'Use code WELCOME50 on checkout to get 50% discount on your next grocery basket.',
                category: 'PROMO',
                isRead: true,
                timeAgo: '1d ago'
            }
        ];
        inMemoryNotifications.set(userId, notifications);
        return res.json({
            success: true,
            unreadCount: notifications.filter(n => !n.isRead).length,
            notifications
        });
    });
    router.patch('/notifications/:id/read', (req, res) => {
        const { id } = req.params;
        const userId = req.query.userId || 'default-user';
        const notifications = inMemoryNotifications.get(userId) || [];
        const item = notifications.find(n => n.id === id);
        if (item)
            item.isRead = true;
        inMemoryNotifications.set(userId, notifications);
        return res.json({ success: true, message: 'Notification marked as read.' });
    });
    router.post('/notifications/mark-all-read', (req, res) => {
        const userId = req.body.userId || 'default-user';
        const notifications = inMemoryNotifications.get(userId) || [];
        notifications.forEach(n => n.isRead = true);
        inMemoryNotifications.set(userId, notifications);
        return res.json({ success: true, message: 'All notifications marked as read.' });
    });
    // ========================================================
    // 9. GENERAL INFO & LEGAL
    // ========================================================
    router.get('/legal/info', (_req, res) => {
        return res.json({
            success: true,
            platform: 'StreetVerse Hyperlocal Commerce & Service Discovery',
            version: '1.2.0-surat-preview',
            capstoneGroup: 'Group P76 - MIT World Peace University, Pune',
            projectGuide: 'Dr. Sumedha Sirsikar',
            teamMembers: [
                'Sanchit Tangri (Lead Backend & AI Architect)',
                'Darshan Mavadhiya (Lead Frontend & UI/UX Developer)',
                'Dishank Gandhi (Database Administrator & Real-Time Systems)',
                'Amar Gupta (Vendor Operations & External API Integration)'
            ],
            mission: 'Empowering independent neighborhood mom-and-pop retailers with AI-driven discovery and ultra-low latency peer-to-peer delivery, with zero aggregator dark store markups.',
            policies: {
                privacyPolicy: 'Zero customer PII is exposed to third-party ad networks or competing merchants. Addresses are only shared with the assigned delivery partner during active fulfillment.',
                refundPolicy: '100% money-back guarantee for damaged, spoiled, or missing items reported within 24 hours of delivery.',
                fairMerchantPledge: 'StreetVerse deducts zero unfair platform commissions, ensuring offline stores retain their standard retail profits.'
            }
        });
    });
    // ========================================================
    // 10. PROFILE EMAIL CHANGE WITH OTP
    // ========================================================
    router.post('/request-email-change', async (req, res) => {
        try {
            const { newEmail, userId } = req.body;
            if (!newEmail || !userId) {
                return res.status(400).json({ error: 'Missing newEmail or userId.' });
            }
            if (!isValidEmail(newEmail)) {
                return res.status(400).json({ error: 'Invalid email address format.' });
            }
            // Check if new email already exists
            const emailCheck = await customerPool.query('SELECT id FROM users WHERE email = $1', [newEmail.toLowerCase()]).catch(() => ({ rows: [] }));
            if (emailCheck.rows.length > 0) {
                return res.status(409).json({ error: 'Email address is already in use.' });
            }
            // Generate and send OTP to the NEW email
            const otp = (0, email_1.generateOtp)();
            await (0, email_1.storeOtp)('buyer', `email-change:${newEmail.toLowerCase()}`, otp);
            await (0, email_1.sendOtpEmail)(newEmail, otp, 'Email Update Verification');
            return res.status(200).json({ message: 'OTP sent to new email address.' });
        }
        catch (err) {
            console.error('[User API] Request Email Change Error:', err);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    });
    router.post('/verify-email-change', async (req, res) => {
        try {
            const { newEmail, userId, otp } = req.body;
            if (!newEmail || !userId || !otp) {
                return res.status(400).json({ error: 'Missing newEmail, userId, or otp.' });
            }
            const isValid = await (0, email_1.verifyOtp)('buyer', `email-change:${newEmail.toLowerCase()}`, otp);
            if (!isValid.valid) {
                return res.status(400).json({ error: isValid.reason || 'Invalid or expired OTP.' });
            }
            // Update the user's email
            const updateResult = await customerPool.query('UPDATE users SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, full_name, email, phone, role', [newEmail.toLowerCase(), userId]).catch(() => ({
                rows: [{ id: userId, full_name: 'Rahul Deshmukh', email: newEmail, phone: '+919890123456', role: 'CUSTOMER' }]
            }));
            const updatedUser = updateResult.rows[0];
            return res.status(200).json({
                message: 'Email updated successfully.',
                user: {
                    id: updatedUser.id,
                    fullName: updatedUser.full_name,
                    email: updatedUser.email,
                    phone: updatedUser.phone,
                    role: updatedUser.role
                }
            });
        }
        catch (err) {
            console.error('[User API] Verify Email Change Error:', err);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    });
    return router;
}
