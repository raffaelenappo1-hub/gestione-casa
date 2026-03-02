/**
 * Gestione Casa - Detailed Category Budgeting
 * v30 - Fix Bilanci e Saldo Iniziale
 */

// 1. GLOBAL NAVIGATION & UTILS
window.switchTab = function (id) {
    const sections = document.querySelectorAll('.view-section');
    sections.forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });

    const target = document.getElementById(`view-${id}`);
    if (target) { target.classList.remove('hidden'); target.classList.add('active'); }

    const navs = document.querySelectorAll('.nav-item, .nav-btn, .bottom-nav .nav-item');
    navs.forEach(n => n.classList.remove('active'));

    document.querySelectorAll(`[data-tab="${id}"]`).forEach(n => n.classList.add('active'));
    document.querySelectorAll('.bottom-nav .nav-item').forEach(btn => {
        if (btn.getAttribute('onclick')?.includes(`'${id}'`)) btn.classList.add('active');
    });

    // Close mobile filter drawer on tab switch (only on mobile)
    if (window.innerWidth < 1025) {
        const drawer = document.getElementById('filters-drawer');
        if (drawer) drawer.classList.add('hidden');
        const toggleBtn = document.getElementById('mobile-filter-toggle');
        if (toggleBtn) toggleBtn.classList.remove('active');
    }

    if (window.UI_REFRESH) window.UI_REFRESH();
};

document.addEventListener('DOMContentLoaded', () => {

    const Store = {
        STORAGE_KEY: 'gestione-casa-money-lover-v1',
        ALT_KEYS: ['money-mgr-v1', 'gestione-casa-v1', 'gestione-casa-transactions'],

        data: {
            transactions: [],
            accounts: [],
            groups: [],
            categories: [],
            budgets: [],
            contracts: [],   // Alloggi 2.0
            rentDues: [],    // Canoni dovuti (Debiti)
            rentAllocations: [], // Collegamento Pagamenti -> Canoni
            savings: {
                balance: 0,
                history: [], // { id, date, amount, type: 'monthly'|'extra'|'withdrawal', note }
                settings: {
                    monthlyContribution: 150,
                    extraAllocation: 0.5,
                    minMainBalance: 1500,
                    goals: [2500, 5000],
                    fixedExpenses: 835
                }
            },
            budgetSettings: {
                startDate: '', // 'YYYY-MM-DD'
                endDate: '',   // 'YYYY-MM-DD'
                totalAmount: 1000,
                categoryBudgets: {} // { categoryId: amount }
            }
        },

        init() {
            try {
                const keys = [this.STORAGE_KEY, ...this.ALT_KEYS];
                let allTrx = [], allAcc = [], allGrp = [], allCat = [], allRec = [], allBud = [];

                // Load primary data
                const raw = localStorage.getItem(this.STORAGE_KEY);
                let primaryData = raw ? JSON.parse(raw) : null;

                // Migration: Only if primary is empty or missing structure
                if (!primaryData || !primaryData.transactions || primaryData.transactions.length === 0) {
                    this.ALT_KEYS.forEach(key => {
                        if (primaryData && primaryData.transactions && primaryData.transactions.length > 0) return;
                        const altRaw = localStorage.getItem(key);
                        if (!altRaw) return;
                        try {
                            const parsed = JSON.parse(altRaw);
                            if (Array.isArray(parsed)) {
                                allTrx = allTrx.concat(parsed);
                            } else if (parsed && typeof parsed === 'object') {
                                if (Array.isArray(parsed.transactions)) allTrx = allTrx.concat(parsed.transactions);
                                if (Array.isArray(parsed.accounts)) allAcc = allAcc.concat(parsed.accounts);
                                if (Array.isArray(parsed.groups)) allGrp = allGrp.concat(parsed.groups);
                                if (Array.isArray(parsed.categories)) allCat = allCat.concat(parsed.categories);
                                if (Array.isArray(parsed.recurring)) allRec = allRec.concat(parsed.recurring);
                                if (Array.isArray(parsed.budgets)) allBud = allBud.concat(parsed.budgets);
                            }
                        } catch (e) { }
                    });
                } else {
                    allTrx = primaryData.transactions || [];
                    allAcc = primaryData.accounts || [];
                    allGrp = primaryData.groups || [];
                    allCat = primaryData.categories || [];
                    allRec = primaryData.recurring || [];
                    allBud = primaryData.budgets || [];
                    this.data.contracts = primaryData.contracts || [];
                    this.data.rentDues = primaryData.rentDues || [];
                    this.data.rentAllocations = primaryData.rentAllocations || [];
                    this.data.savings = primaryData.savings || {
                        balance: 0, history: [],
                        settings: { monthlyContribution: 150, extraAllocation: 0.5, minMainBalance: 1500, goals: [2500, 5000], fixedExpenses: 835 }
                    };
                }

                // --- BONIFICA LOGICA v32: Deduplicazione Semantica Affitti ---
                const seenTrxId = new Set();
                const seenRentKey = new Set(); // accountId|month|amount
                const seenTrxContent = new Set();

                this.data.transactions = allTrx.filter(t => {
                    if (!t || !t.id) return false;

                    // 1. Killer per transazioni automatiche residue (User gestisce tutto manuale ora)
                    const isAuto = String(t.id).startsWith('auto_');
                    const isRentTrx = t.category === 'cat_rent' || (t.description && t.description.toLowerCase().includes('affitto'));
                    if (isAuto && isRentTrx) return false;

                    // 2. Controllo ID Assoluto (Unicità tecnica)
                    if (seenTrxId.has(t.id)) return false;
                    seenTrxId.add(t.id);

                    // 3. DEDUPLICAZIONE SEMANTICA (Il fix per i +350€)
                    // Se nello stesso mese lo stesso conto riceve più incassi affitto uguali, ne teniamo SOLO UNO.
                    if (isRentTrx && t.type === 'income') {
                        let month = '';
                        if (t.description.includes('(')) {
                            const match = t.description.match(/\((.*?)\)/);
                            month = match ? match[1] : '';
                        }
                        if (!month) month = String(t.date).substring(0, 7); // YYYY-MM

                        const rentKey = `${t.accountId}|${month}|${t.amount}`;
                        if (seenRentKey.has(rentKey)) return false;
                        seenRentKey.add(rentKey);
                    }

                    // 4. Sanity check per transazioni generiche
                    const contentKey = `${t.accountId}|${t.type}|${t.amount}|${String(t.date || '').split('T')[0]}|${(t.description || '').toLowerCase().trim()}`;
                    if (seenTrxContent.has(contentKey) && !isRentTrx) return false;
                    seenTrxContent.add(contentKey);

                    return true;
                });

                // Deduplicate recurring rules and REMOVE RENT ONES (user manages manually)
                const seenRec = new Set();
                this.data.recurring = allRec.filter(r => {
                    if (!r) return false;
                    // (Auto-delete logic removed for user preference)
                    if (!r) return false;

                    const hash = `${r.categoryId}|${r.amount}|${r.description}`.toLowerCase();
                    if (seenRec.has(hash)) return false;
                    seenRec.add(hash);
                    return r.id;
                });

                // Deduplicate others by name
                const dedupeByName = (arr) => {
                    const seen = new Set();
                    return arr.filter(i => {
                        if (!i || !i.name) return false;
                        const n = i.name.toLowerCase().trim();
                        if (seen.has(n)) return false;
                        seen.add(n);
                        return true;
                    });
                };

                this.data.accounts = dedupeByName(allAcc);
                this.data.groups = dedupeByName(allGrp);
                this.data.categories = dedupeByName(allCat);
                this.data.budgets = Array.isArray(allBud) ? allBud : [];

                if (this.data.accounts.length === 0) {
                    this.data.accounts = [
                        { id: 'acc_cash', name: 'Contanti', balance: 0, initialBalance: 0, icon: 'fa-wallet', color: '#27ae60' },
                        { id: 'acc_bank', name: 'Conto Banca', balance: 0, initialBalance: 0, icon: 'fa-university', color: '#2c3e50' }
                    ];
                }

                // MIGRATION: Ensure all objects have a color based on their icon
                const applyColors = (arr) => {
                    arr.forEach(item => {
                        if (!item.color) {
                            const iconData = ICONS_LIST.find(i => i.icon === item.icon);
                            item.color = iconData ? iconData.color : '#666';
                        }
                    });
                };
                applyColors(this.data.accounts);
                applyColors(this.data.groups);
                applyColors(this.data.categories);

                this.recalculateBalances();
                this.checkRecurring();
                this.save();
                UI.updateAll();

                window.switchTab('transactions');

                // 2. MOBILE FILTER DRAWER LOGIC
                const mobileFilterToggle = document.getElementById('mobile-filter-toggle');
                const filtersDrawer = document.getElementById('filters-drawer');
                const closeFiltersBtn = document.getElementById('close-filters-btn');

                if (mobileFilterToggle && filtersDrawer) {
                    mobileFilterToggle.addEventListener('click', () => {
                        filtersDrawer.classList.toggle('hidden');
                        mobileFilterToggle.classList.toggle('active');
                    });
                }

                if (closeFiltersBtn && filtersDrawer) {
                    closeFiltersBtn.addEventListener('click', () => {
                        filtersDrawer.classList.add('hidden');
                        mobileFilterToggle.classList.remove('active');
                    });
                }

                // Close drawer when clicking outside the sidebar
                if (filtersDrawer) {
                    filtersDrawer.addEventListener('click', (e) => {
                        if (e.target === filtersDrawer) {
                            filtersDrawer.classList.add('hidden');
                            mobileFilterToggle.classList.remove('active');
                        }
                    });
                }
            } catch (err) { console.error("Store Init error", err); }
        },

        save() {
            const dataToSave = {
                transactions: this.data.transactions,
                accounts: this.data.accounts,
                groups: this.data.groups,
                categories: this.data.categories,
                recurring: this.data.recurring,
                budgets: this.data.budgets,
                contracts: this.data.contracts,
                rentDues: this.data.rentDues,
                rentAllocations: this.data.rentAllocations,
                savings: this.data.savings
            };
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(dataToSave));
        },

        // --- BACKUP & RESTORE ---

        exportBackup() {
            try {
                this.recalculateBalances(); // Ensure consistency
                const backupData = {
                    version: "31",
                    timestamp: new Date().toISOString(),
                    data: this.data
                };
                const json = JSON.stringify(backupData, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);

                const now = new Date();
                const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
                const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '');

                const a = document.createElement('a');
                a.href = url;
                a.download = `backup_${dateStr}_${timeStr}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error("Export failed", err);
                alert("Errore durante la creazione del backup");
            }
        },

        importBackup(file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const imported = JSON.parse(e.target.result);

                    // Basic Validation
                    if (!imported.data || !imported.data.transactions || !imported.data.accounts) {
                        throw new Error("Il file selezionato non sembra un backup valido di questa applicazione.");
                    }

                    if (confirm("ATTENZIONE: Il ripristino sostituirà TUTTI i dati attuali con quelli del file selezionato. Vuoi continuare?")) {
                        this.data = imported.data;
                        this.recalculateBalances();

                        // Recalculate all property ledgers too
                        if (Array.isArray(this.data.properties)) {
                            this.data.properties.forEach(p => this.recalculatePropertyLedger(p));
                        }

                        this.save();
                        UI.updateAll();
                        alert("Dati ripristinati correttamente!");
                        window.switchTab('transactions');
                    }
                } catch (err) {
                    console.error("Import failed", err);
                    alert("Errore durante il ripristino: " + err.message);
                }
            };
            reader.readAsText(file);
        },

        recalculateBalances() {
            this.data.accounts.forEach(a => a.balance = parseFloat(a.initialBalance) || 0);
            this.data.transactions.forEach(t => {
                // Se la transazione è esplicitamente esclusa (es. acconti storici), la saltiamo
                if (t.isAccounting === false) return;

                const amt = parseFloat(t.amount) || 0;
                const acc = this.data.accounts.find(a => a.id === t.accountId);
                if (acc) {
                    if (t.type === 'income') acc.balance += amt;
                    else if (t.type === 'expense') acc.balance -= amt;
                    else if (t.type === 'transfer') {
                        acc.balance -= amt;
                        const dest = this.data.accounts.find(a => a.id === t.toAccountId);
                        if (dest) dest.balance += amt;
                    }
                }
            });

            // Logic for savings integration
            this.data.savings.balance = 0;
            this.data.savings.history.forEach(h => {
                const amt = parseFloat(h.amount) || 0;
                const isWithdrawal = h.type === 'withdrawal';

                // Update total savings fund balance
                if (isWithdrawal) this.data.savings.balance -= amt;
                else this.data.savings.balance += amt;

                // Update the linked account balance if present
                if (h.accountId) {
                    const acc = this.data.accounts.find(a => a.id === h.accountId);
                    if (acc) {
                        // If we ADD to savings (monthly/extra), we DEDUCT from account
                        // If we WITHDRAW from savings, we ADD to account
                        if (isWithdrawal) acc.balance += amt;
                        else acc.balance -= amt;
                    }
                }
            });
        },

        checkRecurring() {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            let added = false;
            let indicesToRemove = [];

            this.data.recurring.forEach((r, idx) => {
                if (!r.nextDueDate) return;

                // (Auto-delete logic removed for user preference)

                let next = new Date(r.nextDueDate);

                while (today >= next) {
                    // Critical: Check if this specific occurrence was already added
                    const occurrenceDate = next.toISOString().split('T')[0];
                    const alreadyExists = this.data.transactions.some(t =>
                        t.type === (r.type || 'expense') &&
                        t.amount == r.amount &&
                        t.date.split('T')[0] === occurrenceDate &&
                        t.category === r.categoryId &&
                        t.description.includes(r.description)
                    );

                    if (!alreadyExists) {
                        this.data.transactions.unshift({
                            id: 'auto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                            type: r.type || 'expense',
                            amount: r.amount,
                            description: r.description + ' (Ricorrente)',
                            date: next.toISOString(),
                            accountId: r.accountId,
                            category: r.categoryId
                        });
                        added = true;
                    }

                    if (r.repeat) {
                        next.setMonth(next.getMonth() + 1);
                        r.nextDueDate = next.toISOString();
                    } else {
                        indicesToRemove.push(idx);
                        break;
                    }
                }
            });

            if (indicesToRemove.length > 0) {
                this.data.recurring = this.data.recurring.filter((_, idx) => !indicesToRemove.includes(idx));
            }
            if (added || indicesToRemove.length > 0) {
                this.recalculateBalances();
                this.save();
            }
        },

        // --- ALLOGGI 2.0: CLEANUP TOOL ---
        getCleanupCandidates() {
            const trxs = this.data.transactions;
            const rentKeywords = ['mario', 'affitto', 'incasso', 'scadenza'];
            return trxs.filter(t => {
                const desc = (t.description || '').toLowerCase();
                const isRentCat = t.category === 'cat_rent';
                const hasProp = !!t.propertyId;
                const hasKeyword = rentKeywords.some(k => desc.includes(k));
                return isRentCat || hasProp || (t.type === 'income' && hasKeyword);
            }).sort((a, b) => new Date(b.date) - new Date(a.date));
        },

        bulkDelete(ids) {
            if (!ids || ids.length === 0) return;
            const strIds = ids.map(id => String(id));
            const countBefore = this.data.transactions.length;

            // 1. Remove from Global Transactions
            this.data.transactions = this.data.transactions.filter(t => !strIds.includes(String(t.id)));

            // 2. Remove related Rent Allocations
            if (this.data.rentAllocations) {
                this.data.rentAllocations = this.data.rentAllocations.filter(a => !strIds.includes(String(a.transactionId)));
            }

            this.recalculateBalances();
            this.save();
            return countBefore - this.data.transactions.length;
        },

        // --- ALLOGGI 2.0: LOGICA DETERMINISTICA ---

        getContractStats(contractId) {
            console.log('Fetching stats for contract ID:', contractId);
            const dues = this.data.rentDues.filter(d => String(d.contractId) === String(contractId));
            const allocations = this.data.rentAllocations.filter(a => String(a.contractId) === String(contractId));
            console.log(`Found ${dues.length} dues and ${allocations.length} allocations.`);

            const totalDue = dues.reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
            const totalAllocated = allocations.reduce((s, a) => s + (parseFloat(a.allocatedAmount) || 0), 0);

            return {
                totalDue,
                totalPaid: totalAllocated,
                arrears: Math.max(0, totalDue - totalAllocated),
                dues: dues.sort((a, b) => b.referenceMonth.localeCompare(a.referenceMonth)),
                allocations: allocations.sort((a, b) => b.referenceMonth.localeCompare(a.referenceMonth))
            };
        },

        /**
         * Registra un pagamento e crea le relative allocazioni coprendo i debiti più vecchi.
         */
        registerRentPayment(contractId, amount, accountId, datePaid, dateRef, notes, isAccounting = true) {
            const contract = this.data.contracts.find(c => c.id === contractId);
            if (!contract) return;

            // 1. Crea la Transazione Finanziaria (L'UNICA che muove soldi)
            const trxId = 'trx_rent_' + Date.now();
            this.data.transactions.push({
                id: trxId,
                accountId,
                date: dateRef, // Data contabile (Mese di riferimento)
                realDate: datePaid,
                amount: parseFloat(amount),
                type: 'income',
                category: 'cat_rent',
                description: `Affitto ${contract.propName} - ${notes || ''}`,
                propertyId: contractId, // Per retrocompatibilità e filtri
                isAccounting: isAccounting // Flag per saltare il ricalcolo saldi se falso
            });

            // 2. Logica di Allocazione (Paga i debiti scoperti)
            let remainingAmount = parseFloat(amount);

            // Trova i canoni dovuti (ordinati per data) che non sono ancora pienamente coperti
            const allDues = this.data.rentDues
                .filter(d => d.contractId === contractId)
                .sort((a, b) => a.referenceMonth.localeCompare(b.referenceMonth));

            for (const due of allDues) {
                if (remainingAmount <= 0) break;

                // Calcola quanto manca per coprire questo canone
                const alreadyAllocated = this.data.rentAllocations
                    .filter(a => a.dueId === due.id)
                    .reduce((s, a) => s + a.allocatedAmount, 0);

                const needed = due.amount - alreadyAllocated;
                if (needed > 0) {
                    const toAllocate = Math.min(remainingAmount, needed);
                    this.data.rentAllocations.push({
                        id: 'alloc_' + Date.now() + Math.random(),
                        transactionId: trxId,
                        dueId: due.id,
                        contractId: contractId,
                        referenceMonth: due.referenceMonth,
                        allocatedAmount: toAllocate
                    });
                    remainingAmount -= toAllocate;
                }
            }

            // Se avanza credito (acconto su mesi futuri non ancora registrati in dues)
            if (remainingAmount > 0) {
                this.data.rentAllocations.push({
                    id: 'alloc_credit_' + Date.now(),
                    transactionId: trxId,
                    dueId: null, // Nessun canone specifico ancora associato
                    contractId: contractId,
                    referenceMonth: 'Eccedenza/Acconto',
                    allocatedAmount: remainingAmount
                });
            }

            this.recalculateBalances();
            this.save();
        },

        saveContract(contract) {
            contract.rentAmount = parseFloat(contract.rentAmount) || 0;
            const idx = this.data.contracts.findIndex(c => c.id === contract.id);
            if (idx !== -1) {
                this.data.contracts[idx] = contract;
            } else {
                if (!contract.id) contract.id = 'ct_' + Date.now();
                this.data.contracts.push(contract);
            }
            this.save();
        },

        deleteContract(id) {
            this.data.contracts = this.data.contracts.filter(c => c.id !== id);
            this.data.rentDues = this.data.rentDues.filter(d => d.contractId !== id);
            this.data.rentAllocations = this.data.rentAllocations.filter(a => a.contractId !== id);
            this.save();
        },

        deleteDue(id) {
            this.data.rentDues = this.data.rentDues.filter(d => d.id !== id);
            this.save();
        },

        // --- SAVINGS LOGIC ---
        addSavings(amount, type, note, accountId) {
            const id = 'sav_' + Date.now();
            const date = new Date().toISOString();
            const entry = { id, date, amount: parseFloat(amount), type, note, accountId };
            this.data.savings.history.unshift(entry);
            this.recalculateBalances();
            this.save();
            UI.updateAll();
        },

        withdrawSavings(amount, note, accountId) {
            const id = 'sav_out_' + Date.now();
            const date = new Date().toISOString();
            const entry = { id, date, amount: parseFloat(amount), type: 'withdrawal', note, accountId };
            this.data.savings.history.unshift(entry);
            this.recalculateBalances();
            this.save();
            UI.updateAll();
        },

        deleteSavingsEntry(id) {
            this.data.savings.history = this.data.savings.history.filter(h => h.id !== id);
            this.recalculateBalances();
            this.save();
            UI.updateAll();
        },

        editSavingsEntry(id, newData) {
            const entry = this.data.savings.history.find(h => h.id === id);
            if (!entry) return;

            Object.assign(entry, newData);

            this.recalculateBalances();
            this.save();
            UI.updateAll();
        }
    };
    window.Store = Store;


    const UI = {
        editingId: null,

        formatCurrency(v) {
            const val = parseFloat(v) || 0;
            const parts = val.toFixed(2).split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
            return `${parts.join(',')} €`;
        },

        // Get filtered transactions based on all filters
        getFilteredTransactions() {
            let trxs = [...Store.data.transactions];

            // Search text filter
            const searchText = document.getElementById('filter-search')?.value.toLowerCase().trim();
            if (searchText) {
                trxs = trxs.filter(t => {
                    const desc = (t.description || '').toLowerCase();
                    const amt = t.amount.toString();
                    const cat = Store.data.categories.find(c => c.id === t.category);
                    const catName = cat ? cat.name.toLowerCase() : '';

                    return desc.includes(searchText) || amt.includes(searchText) || catName.includes(searchText);
                });
            }

            // Date range filter
            const dateStart = document.getElementById('filter-date-start')?.value;
            const dateEnd = document.getElementById('filter-date-end')?.value;

            if (dateStart) {
                trxs = trxs.filter(t => new Date(t.date) >= new Date(dateStart));
            }
            if (dateEnd) {
                trxs = trxs.filter(t => new Date(t.date) <= new Date(dateEnd));
            }

            // Category dropdown filter
            const fCat = document.getElementById('filter-category')?.value;
            if (fCat && fCat !== 'all') {
                trxs = trxs.filter(t => t.category === fCat);
            }

            // Account filter
            const fAcc = document.getElementById('filter-account')?.value;
            if (fAcc && fAcc !== 'all') {
                trxs = trxs.filter(t => t.accountId === fAcc);
            }

            return trxs;
        },

        updateAll() {
            try {
                this.populateOptions();
                const filteredTrxs = this.getFilteredTransactions ? this.getFilteredTransactions() : Store.data.transactions;
                const accountsBal = Store.data.accounts.reduce((s, a) => s + (parseFloat(a.balance) || 0), 0);
                const inc = filteredTrxs.filter(t => t.type === 'income').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                const exp = filteredTrxs.filter(t => t.type === 'expense').reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                const now = new Date();

                const plannedValue = Store.data.recurring.reduce((sum, r) => {
                    if (!r.nextDueDate) return sum;
                    const d = new Date(r.nextDueDate);
                    const isInRange = d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                    return isInRange ? sum + (parseFloat(r.amount) || 0) : sum;
                }, 0);

                const elBal = document.getElementById('total-balance');
                const elInc = document.getElementById('total-income');
                const elExp = document.getElementById('total-expense');
                const elPla = document.getElementById('total-planned');

                if (elBal) elBal.textContent = this.formatCurrency(accountsBal);
                if (elInc) elInc.textContent = this.formatCurrency(inc);
                if (elExp) elExp.textContent = this.formatCurrency(exp);
                if (elPla) elPla.textContent = this.formatCurrency(plannedValue);

                this.renderTopAccounts();
                this.renderTimelineSummary(inc, exp);
                this.renderTimeline();
                this.renderAccounts();
                this.renderCategories();
                this.renderRecurring();
                this.renderBudget();
                this.renderMultiBudgetSettings();
                this.renderProperties();
                this.renderCharts();
                this.renderSavings();
            } catch (e) { console.error("UI error", e); }
        },

        renderSavings() {
            const sav = Store.data.savings;
            const elTotal = document.getElementById('savings-total');
            const elMsg = document.getElementById('savings-message');
            const elBaseVal = document.getElementById('goal-base-val');
            const elIdealVal = document.getElementById('goal-ideal-val');
            const barBase = document.getElementById('progress-base');
            const barIdeal = document.getElementById('progress-ideal');
            const elProj = document.getElementById('savings-projection-text');
            const list = document.getElementById('savings-history-list');

            if (!elTotal) return;

            elTotal.textContent = this.formatCurrency(sav.balance);
            if (sav.balance < 2500) {
                elMsg.innerHTML = '<i class="fas fa-seedling"></i> Stai costruendo la tua tranquillità. Ogni piccolo passo conta!';
            } else if (sav.balance < 5000) {
                elMsg.innerHTML = '<i class="fas fa-shield-alt"></i> Sei a metà strada! Il tuo fondo ti protegge già dalle piccole tempeste.';
            } else {
                elMsg.innerHTML = '<i class="fas fa-crown"></i> Incredibile! Hai raggiunto l\'obiettivo ideale. Sei finanziariamente resiliente.';
            }

            const percBase = Math.min(100, (sav.balance / 2500) * 100);
            const percIdeal = Math.min(100, (sav.balance / 5000) * 100);

            elBaseVal.textContent = `${this.formatCurrency(sav.balance)} / 2.500 €`;
            elIdealVal.textContent = `${this.formatCurrency(sav.balance)} / 5.000 €`;
            barBase.style.width = `${percBase}%`;
            barIdeal.style.width = `${percIdeal}%`;

            if (sav.balance < 5000) {
                const target = sav.balance < 2500 ? 2500 : 5000;
                const needed = target - sav.balance;
                const months = Math.ceil(needed / 150);
                elProj.textContent = `Con 150€ al mese, raggiungerai il prossimo obiettivo tra circa ${months} mesi.`;
            } else {
                elProj.textContent = "Obiettivo massimo raggiunto! Continua così per una sicurezza totale.";
            }

            if (sav.history && sav.history.length === 0) {
                list.innerHTML = '<div style="text-align:center; padding:20px; color:#999;">Ancora nessun accantonamento.</div>';
            } else if (sav.history) {
                list.innerHTML = sav.history.map(h => `
                    <div class="transaction-item">
                        <div class="t-row-main">
                            <div class="t-col-icon">
                                <i class="fas ${h.type === 'withdrawal' ? 'fa-hand-holding-medical' : 'fa-piggy-bank'}" 
                                   style="color:${h.type === 'withdrawal' ? '#e74c3c' : '#27ae60'};"></i>
                            </div>
                            <div class="t-info-box">
                                <span class="t-cat-name" style="font-size: 1.4rem;">${h.type === 'extra' ? 'Entrata Extra (50%)' : (h.type === 'monthly' ? 'Risparmio Mensile' : 'Prelievo Emergenza')}</span>
                                <span class="t-acc-name" style="font-size: 1.4rem;">
                                    ${new Date(h.date).toLocaleDateString('it-IT')} 
                                    ${h.accountId ? `• <i class="fas fa-wallet" style="font-size: 1.3rem;"></i> ${Store.data.accounts.find(a => a.id === h.accountId)?.name || 'N/D'}` : ''}
                                </span>
                            </div>
                            <div class="t-amount" style="color: ${h.type === 'withdrawal' ? 'var(--expense-color)' : 'var(--income-color)'}">
                                ${h.type === 'withdrawal' ? '-' : '+'}${this.formatCurrency(h.amount)}
                            </div>
                            <div class="item-actions" style="opacity:1;">
                                <button onclick="window.editSavTrx('${h.id}')" class="t-action-btn" title="Modifica"><i class="fas fa-pen"></i></button>
                                <button onclick="window.delSavTrx('${h.id}')" class="t-action-btn" title="Elimina"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                        ${h.note ? `<div class="t-row-note">${h.note}</div>` : ''}
                    </div>
                `).join('');
            }
        },

        renderTimelineSummary(inc, exp) {
            const budgetContainer = document.getElementById('top-budget-residue-container');
            if (!budgetContainer) return;

            const periods = this.getBudgetPeriods();
            const current = periods[0];
            if (current) {
                const totalSpent = Store.data.transactions
                    .filter(t => t.type === 'expense' && new Date(t.date) >= current.start && new Date(t.date) <= current.end)
                    .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

                const limit = parseFloat(current.limit) || 1;
                const remaining = limit - totalSpent;
                const perc = Math.min(100, Math.max(0, (totalSpent / limit) * 100));

                let color = '#f1c40f';
                if (perc < 50) color = '#2ecc71';
                if (perc >= 90) color = '#e74c3c';

                budgetContainer.innerHTML = `
                    <div class="budget-label">BUDGET RESIDUO</div>
                    <div class="budget-bar">
                        <div class="budget-fill" style="width: ${perc}%;"></div>
                    </div>
                    <div class="budget-amount">${this.formatCurrency(remaining)}</div>
                `;
            } else {
                budgetContainer.innerHTML = '';
            }
        },

        renderTopAccounts() {
            const row = document.getElementById('top-accounts-row');
            if (!row) return;

            let html = Store.data.accounts.map(a => {
                const bal = parseFloat(a.balance) || 0;
                const isNeg = bal < 0;
                return `
                    <div class="account-card" style="border-left-color: ${a.color || 'var(--primary-color)'}">
                        <span class="acc-name">${a.name}</span>
                        <span class="acc-balance" style="color: ${isNeg ? 'var(--expense-color)' : 'inherit'}">
                            ${this.formatCurrency(bal)}
                        </span>
                    </div>
                `;
            }).join('');

            // Add Savings Fund card
            const savBal = Store.data.savings.balance;
            html += `
                <div class="account-card" style="border-left-color: #27ae60; cursor: pointer;" onclick="switchTab('savings')">
                    <span class="acc-name">💰 Cassetto Risparmi</span>
                    <span class="acc-balance" style="color: var(--income-color)">
                        ${this.formatCurrency(savBal)}
                    </span>
                </div>
            `;

            row.innerHTML = html;
        },

        populateOptions() {
            const sels = ['account-id', 'to-account-id', 'category', 'rec-account-id', 'rec-category', 'budget-cat-select', 'filter-category', 'filter-account'];
            const accs = Store.data.accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');

            // Add virtual savings account for transfers
            const accsWithSavings = accs + '<option value="virtual_savings">💰 Cassetto Risparmi</option>';

            const cats = Store.data.groups.map(g => {
                const groupCats = Store.data.categories.filter(c => c.groupId === g.id);
                return `<optgroup label="${g.name}">${groupCats.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}</optgroup>`;
            }).join('');

            sels.forEach(id => {
                const el = document.getElementById(id); if (el) {
                    const val = el.value;
                    if (id.includes('category') || id.includes('cat')) {
                        el.innerHTML = id.startsWith('filter') ? '<option value="all">Tutte le categorie</option>' + cats : cats;
                    } else {
                        // Include savings only for main transaction modal and filter
                        const finalAccs = (id === 'account-id' || id === 'to-account-id' || id === 'filter-account') ? accsWithSavings : accs;
                        el.innerHTML = id.startsWith('filter') ? '<option value="all">Tutti i conti</option>' + finalAccs : finalAccs;
                    }
                    if (val) el.value = val;
                }
            });

            const yearSel = document.getElementById('filter-year');
            if (yearSel && yearSel.innerHTML.trim() === '') {
                const cy = new Date().getFullYear();
                let yhtml = '<option value="all">Tutti gli anni</option>';
                for (let y = cy; y >= cy - 5; y--) { yhtml += `<option value="${y}">${y}</option>`; }
                yearSel.innerHTML = yhtml;
            }
        },

        renderTimeline() {
            const list = document.getElementById('timeline-list'); if (!list) return;

            // Use new filtering system
            const trxs = this.getFilteredTransactions ? this.getFilteredTransactions() : [...Store.data.transactions];

            if (trxs.length === 0) {
                list.innerHTML = `<div class="empty-state"><i class="fas fa-receipt"></i><p>Nessun movimento trovato</p></div>`;
                return;
            }

            const groups = {};
            trxs.forEach(t => {
                const d = String(t.date || '').split('T')[0] || '0000-00-00';
                if (!groups[d]) groups[d] = [];
                groups[d].push(t);
            });

            list.innerHTML = '';
            Object.keys(groups).sort((a, b) => new Date(b) - new Date(a)).forEach(date => {
                const dayDiv = document.createElement('div');
                dayDiv.className = 'day-group';

                let daySum = groups[date].reduce((s, t) => {
                    const am = parseFloat(t.amount) || 0;
                    return t.type === 'income' ? s + am : (t.type === 'expense' ? s - am : s);
                }, 0);

                let html = `
                    <div class="day-header">
                        <span class="day-date">${new Date(date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                        <span class="day-total" style="color: ${daySum < 0 ? 'var(--expense-color)' : 'var(--income-color)'}">
                            ${daySum > 0 ? '+' : ''}${this.formatCurrency(daySum)}
                        </span>
                    </div>
                `;

                groups[date].forEach(t => {
                    const type = String(t.type || 'expense').toLowerCase();
                    const isTransfer = type === 'transfer';
                    const cat = isTransfer ? { name: 'Giroconto', icon: 'fa-right-left', color: 'var(--transfer-color)' } : Store.data.categories.find(c => c.id === t.category);
                    const acc = Store.data.accounts.find(a => a.id === t.accountId);

                    html += `
                        <div class="transaction-item" data-type="${type}">
                            <div class="t-row-main">
                                <div class="t-col-icon">
                                    <i class="fas ${cat ? cat.icon : 'fa-receipt'}" style="color:${cat?.color || '#64748b'};"></i>
                                </div>
                                <div class="t-info-box">
                                    <span class="t-cat-name">${cat ? cat.name : 'Altro'}</span>
                                    <span class="t-acc-name">
                                        <i class="fas fa-wallet" style="font-size: 1.4rem;"></i> ${acc ? acc.name : 'N/D'}
                                    </span>
                                </div>
                                <div class="t-amount" style="color: ${type === 'income' ? 'var(--income-color)' : (type === 'expense' ? 'var(--expense-color)' : 'var(--text-primary)')}">
                                    ${type === 'income' ? '+' : (type === 'expense' ? '-' : '')}${this.formatCurrency(t.amount)}
                                </div>
                                <div class="item-actions" style="opacity:1;">
                                    <button onclick="window.editTrx('${t.id}')" class="t-action-btn" title="Modifica"><i class="fas fa-pen"></i></button>
                                    <button onclick="window.delTrx('${t.id}')" class="t-action-btn" title="Elimina"><i class="fas fa-trash"></i></button>
                                </div>
                            </div>
                            ${t.description ? `<div class="t-row-note">${t.description}</div>` : ''}
                        </div>
                    `;
                });
                dayDiv.innerHTML = html;
                list.appendChild(dayDiv);
            });
        },

        renderAccounts() {
            const list = document.getElementById('accounts-full-list'); if (!list) return;

            let html = Store.data.accounts.map(acc => `
                <div class="transaction-item">
                    <div class="t-row-main">
                        <div class="t-col-icon">
                            <i class="fas ${acc.icon || 'fa-university'}" style="color:${acc.color || 'var(--primary-color)'};"></i>
                        </div>
                        <div class="t-info-box">
                            <span class="t-cat-name">${acc.name}</span>
                            <span class="t-acc-name" style="color:var(--text-secondary);">Saldo Attuale</span>
                        </div>
                        <div class="t-amount" style="color:${parseFloat(acc.balance) < 0 ? 'var(--expense-color)' : 'var(--primary-color)'}">
                            ${this.formatCurrency(acc.balance)}
                        </div>
                        <div class="item-actions" style="opacity: 1;">
                            <button class="t-action-btn" data-action="edit-account" data-id="${acc.id}" title="Modifica">
                                <i class="fas fa-pen"></i>
                            </button>
                            <button class="t-action-btn" data-action="delete-account" data-id="${acc.id}" title="Elimina">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `).join('');

            // Add Savings Fund entry
            const savBal = Store.data.savings.balance;
            html += `
                <div class="transaction-item" style="background: rgba(39, 174, 96, 0.05); border-left: 4px solid #27ae60; margin-top: 10px;">
                    <div class="t-row-main" onclick="switchTab('savings')" style="cursor: pointer;">
                        <div class="t-col-icon">
                            <i class="fas fa-piggy-bank" style="color:#27ae60;"></i>
                        </div>
                        <div class="t-info-box">
                            <span class="t-cat-name">Cassetto Risparmi</span>
                            <span class="t-acc-name" style="color:var(--text-secondary);">Fondo di Resilienza</span>
                        </div>
                        <div class="t-amount" style="color: var(--income-color)">
                            ${this.formatCurrency(savBal)}
                        </div>
                        <div class="item-actions" style="opacity: 1;">
                            <button class="t-action-btn" onclick="switchTab('savings')" title="Vai ai Risparmi">
                                <i class="fas fa-chevron-right"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;

            list.innerHTML = html;
        },

        renderCategories() {
            const list = document.getElementById('categories-full-list'); if (!list) return;
            list.innerHTML = Store.data.groups.map(g => {
                const groupCats = Store.data.categories.filter(c => c.groupId === g.id);
                return `
                <div style="margin-bottom:20px; background:white; border-radius:12px; padding:0; box-shadow:0 1px 3px rgba(0,0,0,0.05); overflow:hidden;">
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:15px; background:#f8fafc; border-bottom:1px solid #eee;">
                        <div style="font-weight:700; color:${g.color || 'var(--primary-color)'}; display:flex; align-items:center;">
                             <i class="fas ${g.icon}" style="margin-right:10px;"></i> ${g.name}
                        </div>
                        <div class="item-actions-container">
                            <button class="action-btn-styled add" data-action="add-category" data-group-id="${g.id}" title="Aggiungi Sottocategoria">
                                <i class="fas fa-plus-circle"></i>
                            </button>
                            <button class="action-btn-styled edit" data-action="edit-group" data-id="${g.id}">
                                <i class="fas fa-pen"></i>
                            </button>
                            <button class="action-btn-styled delete" data-action="delete-group" data-id="${g.id}">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div>
                        ${groupCats.map(c => `
                            <div class="transaction-item" style="padding: 12px 20px; border-bottom: 1px solid #f8f9fa;">
                                <div class="t-row-main">
                                    <div class="t-col-icon" style="width:40px; height:40px; font-size: 1.35rem; margin-right:15px;">
                                        <i class="fas ${c.icon}" style="color:${c.color || '#666'};"></i>
                                    </div>
                                    <div class="t-info-box">
                                        <span class="t-cat-name" style="font-size: 1.45rem;">${c.name}</span>
                                    </div>
                                    <div class="item-actions" style="opacity: 1;">
                                        <button class="t-action-btn" data-action="quick-add" data-id="${c.id}" title="Aggiungi Transazione">
                                            <i class="fas fa-plus"></i>
                                        </button>
                                        <button class="t-action-btn" data-action="edit-category" data-id="${c.id}">
                                            <i class="fas fa-pen"></i>
                                        </button>
                                        <button class="t-action-btn" data-action="delete-category" data-id="${c.id}">
                                            <i class="fas fa-trash"></i>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>`;
            }).join('');
        },

        renderRecurring() {
            const el = document.getElementById('recurring-list'); if (!el) return;
            if (Store.data.recurring.length === 0) { el.innerHTML = '<div class="empty-state"><i class="fas fa-clock"></i><p>Nessuna spesa ricorrente attiva</p></div>'; return; }
            el.innerHTML = Store.data.recurring.map(r => {
                const cat = Store.data.categories.find(c => c.id === r.categoryId);
                const acc = Store.data.accounts.find(a => a.id === r.accountId);
                return `
                <div class="transaction-item" data-type="expense">
                    <div class="t-row-main">
                        <div class="t-col-icon">
                            <i class="fas ${cat ? cat.icon : 'fa-clock'}" style="color:${cat?.color || '#666'};"></i>
                        </div>
                        <div class="t-info-box">
                            <span class="t-cat-name">${cat ? cat.name : 'Senza Categoria'}</span>
                            <span class="t-acc-name">
                                <i class="fas fa-wallet"></i> ${acc ? acc.name : 'N/D'} • <i class="fas fa-redo"></i> ${r.repeat ? 'Mensile' : 'Singola'}
                            </span>
                        </div>
                        <div class="t-amount" style="color:var(--expense-color);">
                            -${this.formatCurrency(r.amount)}
                        </div>
                        <div class="item-actions" style="opacity: 1;">
                            <button class="t-action-btn" onclick="window.editRec('${r.id}')" title="Modifica">
                                <i class="fas fa-pen"></i>
                            </button>
                            <button class="t-action-btn" onclick="window.delRec('${r.id}')" title="Elimina">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                    <div class="t-row-note">${r.description || 'Nessuna nota'} • Prossima: ${new Date(r.nextDueDate).toLocaleDateString()}</div>
                </div>`;
            }).join('');
        },

        // --- ENHANCED BUDGET RENDERING (v27) ---
        renderBudget() {
            const cardEl = document.getElementById('current-budget-card');
            const historyEl = document.getElementById('budget-history-list');
            if (!cardEl || !historyEl) return;

            const periods = this.getBudgetPeriods();
            const current = periods[0];
            const history = periods.slice(1);

            const currentTrxs = Store.data.transactions
                .filter(t => t.type === 'expense' && new Date(t.date) >= current.start && new Date(t.date) <= current.end);

            const totalSpentOverall = currentTrxs.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
            const settings = current.settings || {};
            const catBudgets = settings.categoryBudgets || {};
            const assignedCatIds = Object.keys(catBudgets);

            const remaining = current.limit - totalSpentOverall;
            const totalPercent = Math.min(100, (totalSpentOverall / current.limit) * 100);

            // Status color logic for main bar
            let mainColor = '#3b82f6'; // Blue
            if (totalPercent >= 100) mainColor = '#ef4444'; // Red
            else if (totalPercent >= 80) mainColor = '#f59e0b'; // Orange

            // 1. HEADER SUMMARY CARD
            let html = `
                <div class="budget-summary-card">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                        <div>
                            <div class="budget-stat-label" style="color:rgba(255,255,255,0.7); font-size: 1.3rem;">Budget Periodo</div>
                            <div style="font-weight:700; font-size:1.45rem;">${current.label}</div>
                        </div>
                        <div class="budget-item-status" style="background:rgba(255,255,255,0.2); color:white; border:1px solid rgba(255,255,255,0.3)">
                            ${current.start.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} - ${current.end.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })}
                        </div>
                    </div>

                    <div style="margin:20px 0;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:8px;">
                            <span style="font-size:2.5rem; font-weight:800;">${this.formatCurrency(remaining)}</span>
                            <span style="font-size: 1.3rem; opacity:0.8;">rimasti di ${this.formatCurrency(current.limit)}</span>
                        </div>
                        <div class="budget-main-progress">
                            <div class="budget-main-progress-bar" style="width:${totalPercent}%; background:${mainColor}; box-shadow: 0 0 10px ${mainColor}44;"></div>
                        </div>
                        <div style="display:flex; justify-content:space-between; font-size: 1.4rem; opacity:0.9;">
                            <span>Speso: ${this.formatCurrency(totalSpentOverall)}</span>
                            <span>${Math.round(totalPercent)}%</span>
                        </div>
                    </div>
                </div>

                <div class="budget-category-list">
                    <div class="flexible-section-title"><i class="fas fa-bullseye"></i> Limiti Fissati Manualmente</div>
            `;

            let spentInAllocated = 0;

            // 2. FIXED BUDGET CATEGORIES
            assignedCatIds.forEach(catId => {
                const catLimit = catBudgets[catId];
                const catTrxs = currentTrxs.filter(t => t.category === catId);
                const catSpent = catTrxs.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                spentInAllocated += catSpent;

                const cat = Store.data.categories.find(c => c.id === catId);
                const catPercent = Math.min(100, (catSpent / catLimit) * 100);

                let statusClass = 'status-ok';
                let statusLabel = 'Ottimo';
                let barColor = cat?.color || '#3b82f6';

                if (catSpent > catLimit) {
                    statusClass = 'status-danger';
                    statusLabel = 'Sforato';
                    barColor = '#ef4444';
                } else if (catPercent > 80) {
                    statusClass = 'status-warning';
                    statusLabel = 'Attenzione';
                    barColor = '#f59e0b';
                }

                html += `
                    <div class="budget-item-card">
                        <div class="budget-item-header">
                            <div class="budget-item-meta">
                                <div class="budget-item-icon" style="background:${(cat?.color || '#666')}15; color:${cat?.color || '#666'};">
                                    <i class="fas ${cat?.icon || 'fa-tag'}"></i>
                                </div>
                                <div class="budget-item-info">
                                    <h4>${cat?.name || 'Sconosciuta'}</h4>
                                </div>
                            </div>
                            <span class="budget-item-status ${statusClass}">${statusLabel}</span>
                        </div>
                        <div style="width:100%; height:8px; background:#f1f5f9; border-radius:10px; overflow:hidden; margin:8px 0;">
                            <div style="width:${catPercent}%; height:100%; background:${barColor}; border-radius:10px; transition: width 0.5s ease;"></div>
                        </div>
                        <div class="budget-mini-stats">
                            <span>Soglia: <b>${this.formatCurrency(catLimit)}</b></span>
                            <span style="text-align:center;">Residuo: <b style="color:${(catLimit - catSpent) >= 0 ? '#10b981' : '#ef4444'}">${this.formatCurrency(catLimit - catSpent)}</b></span>
                            <span style="text-align:right;">Usato: <b>${this.formatCurrency(catSpent)}</b></span>
                        </div>
                    </div>
                `;
            });

            if (assignedCatIds.length === 0) {
                html += `<div style="text-align:center; padding:20px; color:#94a3b8; font-size: 1.4rem;">Nessun limite individuale impostato.</div>`;
            }

            // 3. FLEXIBLE CATEGORIES (REMAINDER)
            const allocatedSum = assignedCatIds.reduce((s, id) => s + (parseFloat(catBudgets[id]) || 0), 0);
            const remainderBudget = Math.max(0, current.limit - allocatedSum);
            const spentInRemainder = totalSpentOverall - spentInAllocated;
            const remainderPercent = Math.min(100, (spentInRemainder / remainderBudget) * 100) || 0;

            let remStatusClass = 'status-ok';
            let remBarColor = '#64748b';
            if (spentInRemainder > remainderBudget) {
                remStatusClass = 'status-danger';
                remBarColor = '#ef4444';
            } else if (remainderPercent > 80) {
                remStatusClass = 'status-warning';
                remBarColor = '#f59e0b';
            }

            html += `
                <div class="flexible-section-title"><i class="fas fa-layer-group"></i> Spese Flessibili (Resto)</div>
                <div class="budget-item-card" style="background: #f8fafc; border: 1px dashed #cbd5e1;">
                    <div class="budget-item-header">
                        <div class="budget-item-meta">
                            <div class="budget-item-icon" style="background:#64748b15; color:#64748b;">
                                <i class="fas fa-shopping-basket"></i>
                            </div>
                            <div class="budget-item-info">
                                <h4>Altre Categorie</h4>
                            </div>
                        </div>
                        <span class="budget-item-status ${remStatusClass}">${remainderPercent > 100 ? 'Sforato' : 'In Corso'}</span>
                    </div>
                    <div style="width:100%; height:8px; background:#e2e8f0; border-radius:10px; overflow:hidden; margin:8px 0;">
                        <div style="width:${remainderPercent}%; height:100%; background:${remBarColor}; border-radius:10px;"></div>
                    </div>
                    <div class="budget-mini-stats">
                        <span>Soglia: <b>${this.formatCurrency(remainderBudget)}</b></span>
                        <span style="text-align:center;">Residuo: <b style="color:${(remainderBudget - spentInRemainder) >= 0 ? '#10b981' : '#ef4444'}">${this.formatCurrency(remainderBudget - spentInRemainder)}</b></span>
                        <span style="text-align:right;">Usato: <b>${this.formatCurrency(spentInRemainder)}</b></span>
                    </div>
                </div>
            </div>`;

            cardEl.innerHTML = html;

            // Simplified History UI
            if (history.length === 0) {
                historyEl.innerHTML = '<p style="text-align:center; color:#ccc; padding:20px;">Nessun periodo precedente</p>';
            } else {
                historyEl.innerHTML = `
                    <div style="background:white; border-radius:16px; border:1px solid #eee; overflow:hidden;">
                        ${history.map((p, idx) => {
                    const pSpent = Store.data.transactions
                        .filter(t => t.type === 'expense' && new Date(t.date) >= p.start && new Date(t.date) <= p.end)
                        .reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                    const pPercent = Math.round((pSpent / p.limit) * 100) || 0;
                    return `
                            <div style="padding:15px; border-bottom: ${idx === history.length - 1 ? 'none' : '1px solid #f1f5f9'}; display:flex; justify-content:space-between; align-items:center;">
                                <div>
                                    <div style="font-weight:700; color:#333; font-size: 1.35rem;">${p.label}</div>
                                    <div style="font-size: 1.4rem; color:#999;">${p.start.toLocaleDateString('it-IT')} - ${p.end.toLocaleDateString('it-IT')}</div>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-weight:700; color:${pSpent > p.limit ? '#e74c3c' : '#2ecc71'}; font-size: 1.45rem;">${this.formatCurrency(pSpent)}</div>
                                    <div style="font-size: 1.4rem; color:#999;">${pPercent}% del budget</div>
                                </div>
                            </div>`;
                }).join('')}
                    </div>
                `;
            }
        },

        renderMultiBudgetSettings() {
            const listEl = document.getElementById('budget-list-container');
            if (!listEl) return;
            const budgets = Store.data.budgets || [];

            if (budgets.length === 0) {
                listEl.innerHTML = '<p style="text-align:center; color:#999; padding:20px; background:white; border-radius:12px;">Nessun periodo personalizzato definito.</p>';
            } else {
                listEl.innerHTML = budgets.map(b => {
                    const startDate = new Date(b.startDate);
                    const endDate = new Date(b.endDate); endDate.setHours(23, 59, 59);

                    // Filter transactions for this specific period
                    const periodTrxs = Store.data.transactions.filter(t => {
                        const d = new Date(t.date);
                        return t.type === 'expense' && d >= startDate && d <= endDate;
                    });

                    const totalSpent = periodTrxs.reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                    const catKeys = Object.keys(b.categoryBudgets || {});
                    const allocatedSum = catKeys.reduce((s, id) => s + (parseFloat(b.categoryBudgets[id]) || 0), 0);
                    const remainderLimit = b.totalAmount - allocatedSum;

                    const residuoTotale = b.totalAmount - totalSpent;

                    let catHtml = `<div class="manage-cat-pills">`;
                    let spentInAllocated = 0;

                    catKeys.forEach(cid => {
                        const cat = Store.data.categories.find(c => c.id === cid);
                        const limit = parseFloat(b.categoryBudgets[cid]) || 0;
                        const spent = periodTrxs.filter(t => t.category === cid).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
                        const res = limit - spent;
                        spentInAllocated += spent;

                        catHtml += `<span class="cat-pill-mini ${res < 0 ? 'overspent' : ''}">
                            <i class="fas ${cat?.icon || 'fa-tag'}"></i>
                            ${cat?.name || cid}: ${this.formatCurrency(limit)} 
                            <small style="margin-left:5px; opacity:0.8; font-size: 1.3rem;">(Res: ${this.formatCurrency(res)})</small>
                        </span>`;
                    });

                    // Add Resto (Remainder)
                    const restoSpent = totalSpent - spentInAllocated;
                    const restoResiduo = remainderLimit - restoSpent;
                    catHtml += `<span class="cat-pill-mini ${restoResiduo < 0 ? 'overspent' : ''}" style="border-style:dashed; background:#f8fafc;">
                        <i class="fas fa-layer-group"></i>
                        Altre (Restanti): ${this.formatCurrency(remainderLimit)}
                        <small style="margin-left:5px; opacity:0.8; font-size: 1.4rem;">(Res: ${this.formatCurrency(restoResiduo)})</small>
                    </span>`;
                    catHtml += `</div>`;

                    return `
                    <div class="manage-budget-item">
                        <div class="manage-budget-grid">
                            <div>
                                <div class="manage-row-main">
                                    <div>
                                        <div style="font-size: 1.4rem; color:#94a3b8; font-weight:600; text-transform:uppercase;">Periodo Validità</div>
                                        <div style="font-weight:700; color:#1e293b; font-size: 1.4rem;">${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}</div>
                                    </div>
                                    <div style="text-align:right;">
                                        <div style="font-size: 1.4rem; color:#94a3b8; font-weight:600; text-transform:uppercase;">Budget Totale</div>
                                        <div style="font-weight:800; color:var(--primary-color); font-size: 1.4rem;">${this.formatCurrency(b.totalAmount)}</div>
                                    </div>
                                </div>
                                
                                <div class="manage-stats-row" style="display:grid; grid-template-columns: repeat(4, 1fr); gap:15px; background:#f8fafc; padding:15px; border-radius:15px;">
                                    <div class="manage-stat-box">
                                        <span class="manage-stat-lbl">Assegnato</span>
                                        <span class="manage-stat-val">${this.formatCurrency(allocatedSum)}</span>
                                    </div>
                                    <div class="manage-stat-box">
                                        <span class="manage-stat-lbl">Speso</span>
                                        <span class="manage-stat-val">${this.formatCurrency(totalSpent)}</span>
                                    </div>
                                    <div class="manage-stat-box">
                                        <span class="manage-stat-lbl">Residuo</span>
                                        <span class="manage-stat-val" style="color:${residuoTotale >= 0 ? '#10b981' : '#ef4444'}">
                                            ${this.formatCurrency(residuoTotale)} ${residuoTotale >= 0 ? '🟢' : '🔴'}
                                        </span>
                                    </div>
                                    <div class="manage-stat-box" style="text-align:right;">
                                        <span class="manage-stat-lbl">Altre (Resto)</span>
                                        <span class="manage-stat-val" style="color:${remainderLimit >= 0 ? '#64748b' : '#ef4444'}">${this.formatCurrency(remainderLimit)}</span>
                                    </div>
                                </div>
                                ${catHtml}
                            </div>
                            <div style="display:flex; flex-direction:column; gap:10px; border-left:1px solid #f1f5f9; padding-left:15px; justify-content:center;">
                                <button onclick="window.editBudgetDefinition('${b.id}')" class="icon-btn" style="color:#3b82f6; background:#eff6ff; width:44px; height:44px; border-radius:12px;"><i class="fas fa-edit"></i></button>
                                <button onclick="window.deleteBudgetDefinition('${b.id}')" class="icon-btn" style="color:#ef4444; background:#fef2f2; width:44px; height:44px; border-radius:12px;"><i class="fas fa-trash-alt"></i></button>
                            </div>
                        </div>
                    </div>
                `;
                }).join('');
            }
        },

        renderBucketBudgetSettings(catBudgets = {}) {
            const listEl = document.getElementById('budget-cat-list');
            if (!listEl) return;
            const keys = Object.keys(catBudgets);

            if (keys.length === 0) {
                listEl.innerHTML = '<p style="font-size: 1.4rem; color:#999; text-align:center;">Nessuna categoria limitata.</p>';
            } else {
                listEl.innerHTML = keys.map(id => {
                    const cat = Store.data.categories.find(c => c.id === id);
                    return `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:5px 0; border-bottom:1px solid #eee;">
                            <span style="font-size: 1.4rem;">${cat ? cat.name : id}</span>
                            <div style="display:flex; align-items:center;">
                                <span style="font-weight:700; font-size: 1.4rem; margin-right:10px;">${this.formatCurrency(catBudgets[id])}</span>
                                <button onclick="window.removeCatBudgetLocal('${id}')" style="color:#e74c3c; background:none; border:none; cursor:pointer;"><i class="fas fa-times"></i></button>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        },

        getBudgetPeriods() {
            const periods = [];
            const now = new Date();
            const allBudgets = Store.data.budgets || [];

            // Sort budgets by startDate DESC
            const sortedBudgets = [...allBudgets].sort((a, b) => new Date(b.startDate) - new Date(a.startDate));

            // ACTIVE: Find budget that contains TODAY, or the most recent one
            let activeIndex = sortedBudgets.findIndex(b => {
                const s = new Date(b.startDate);
                const e = new Date(b.endDate); e.setHours(23, 59, 59);
                return now >= s && now <= e;
            });

            if (activeIndex === -1 && sortedBudgets.length > 0) activeIndex = 0; // Default to most recent

            if (activeIndex !== -1) {
                const b = sortedBudgets[activeIndex];
                const s = new Date(b.startDate);
                const e = new Date(b.endDate); e.setHours(23, 59, 59);
                periods.push({
                    start: s, end: e,
                    label: s.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
                    limit: b.totalAmount,
                    settings: b
                });

                // Add other saved budgets to history
                sortedBudgets.forEach((bOther, idx) => {
                    if (idx === activeIndex) return;
                    const sO = new Date(bOther.startDate);
                    const eO = new Date(bOther.endDate); eO.setHours(23, 59, 59);
                    periods.push({
                        start: sO, end: eO,
                        label: sO.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
                        limit: bOther.totalAmount,
                        settings: bOther
                    });
                });
            }

            // Fallback: If less than 6 periods, add calendar months
            if (periods.length < 6) {
                const fillCount = 6 - periods.length;
                const lastDate = periods.length > 0 ? periods[periods.length - 1].start : now;
                for (let i = 1; i <= fillCount; i++) {
                    const s = new Date(lastDate.getFullYear(), lastDate.getMonth() - i, 1);
                    const e = new Date(lastDate.getFullYear(), lastDate.getMonth() - i + 1, 0, 23, 59, 59);
                    periods.push({
                        start: s, end: e,
                        label: s.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }),
                        limit: Store.data.budgetSettings?.totalAmount || 1000
                    });
                }
            }

            return periods;
        },

        // --- PROPERTIES (ALLOGGI) RENDERING ---
        // --- ALLOGGI 2.0: RENDERING DETERMINISTICO ---
        renderProperties() {
            const list = document.getElementById('properties-list');
            if (!list) return;

            if (Store.data.contracts.length === 0) {
                list.innerHTML = `
                    <div style="text-align:center; padding:40px; color:#94a3b8; background:white; border-radius:12px; border:2px dashed #e2e8f0;">
                        <i class="fas fa-file-contract" style="font-size:3rem; margin-bottom:15px; opacity:0.3;"></i>
                        <p>Nessun contratto registrato.<br><small>Clicca sul "+" per iniziare la versione 2.0.</small></p>
                    </div>`;
                return;
            }

            list.innerHTML = Store.data.contracts.map(c => {
                const stats = Store.getContractStats(c.id);
                return `
                    <div class="card property-card" style="position:relative; overflow:hidden;">
                        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
                            <div>
                                <h4 style="margin:0; font-size: 1.3rem; color:#1e293b;">${c.propName}</h4>
                                <div style="font-size: 1.4rem; color:#64748b;"><i class="fas fa-user"></i> ${c.tenantName}</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-weight:700; color:#1e293b;">${this.formatCurrency(c.rentAmount)}/mese</div>
                                <div style="font-size: 1.4rem; color:#94a3b8;">${c.type || 'Contratto'}</div>
                            </div>
                        </div>

                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px; background:#f8fafc; padding:10px; border-radius:8px;">
                            <div style="text-align:center; border-right:1px solid #e2e8f0;">
                                <div style="font-size: 1.4rem; color:#94a3b8; text-transform:uppercase;">Tot. Incassato</div>
                                <div style="font-weight:700; color:#22c55e; font-size: 1.35rem;">${this.formatCurrency(stats.totalPaid)}</div>
                            </div>
                            <div style="text-align:center;">
                                <div style="font-size: 1.4rem; color:#94a3b8; text-transform:uppercase;">Arretrati</div>
                                <div style="font-weight:700; color:${stats.arrears > 0 ? '#ef4444' : '#22c55e'}; font-size: 1.35rem;">
                                    ${this.formatCurrency(stats.arrears)}
                                </div>
                            </div>
                        </div>

                        <div style="display:flex; gap:10px;">
                            <button onclick="UI.openPayRentModal('${c.id}')" class="btn-save" style="margin:0; flex:1; background:#2ecc71;">Paga Affitto</button>
                            <button onclick="UI.manageArrears('${c.id}')" class="btn-save" style="margin:0; flex:1; background:#3498db;">Storico Inquilino</button>
                            <button onclick="UI.editContract('${c.id}')" class="icon-btn" style="background:#f1f5f9; color:#64748b;"><i class="fas fa-edit"></i></button>
                        </div>
                    </div>
                `;
            }).join('');
        },

        // --- CHARTS (GRAFICI) RENDERING ---
        renderCharts() {
            if (typeof this.getFilteredTransactions !== 'function') {
                console.warn("getFilteredTransactions not available yet.");
                return;
            }
            const trxs = this.getFilteredTransactions().filter(t => t.type !== 'transfer');
            this.renderStats(trxs);
            this.renderTrendChart(trxs);
            this.renderCategoryChart(trxs);
        },

        renderStats(trxs) {
            const cont = document.getElementById('stats-summary');
            if (!cont) return;
            const inc = trxs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
            const exp = trxs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
            const sav = inc - exp;
            cont.innerHTML = `
                <div class="stat-card income"><label>Entrate</label><div class="value">${this.formatCurrency(inc)}</div></div>
                <div class="stat-card expense"><label>Uscite</label><div class="value">${this.formatCurrency(exp)}</div></div>
                <div class="stat-card savings"><label>Risparmio</label><div class="value">${this.formatCurrency(sav)}</div></div>
            `;
        },

        renderTrendChart(trxs) {
            const cont = document.getElementById('trend-chart');
            if (!cont) return;
            const data = {};
            trxs.forEach(t => {
                const d = new Date(t.date);
                if (d.getFullYear() < 2026) return; // Skip legacy test data unless explicitly filtered
                const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (!data[k]) data[k] = { inc: 0, exp: 0 };
                if (t.type === 'income') data[k].inc += t.amount;
                else if (t.type === 'expense') data[k].exp += t.amount;
            });
            const sorted = Object.entries(data).sort().slice(-6);
            const maxVal = Math.max(...sorted.map(([, v]) => Math.max(v.inc, v.exp)), 1);
            cont.innerHTML = sorted.map(([k, v]) => {
                const label = new Date(k + '-01').toLocaleDateString('it-IT', { month: 'short', year: 'numeric' });
                const incH = (v.inc / maxVal * 100).toFixed(1);
                const expH = (v.exp / maxVal * 100).toFixed(1);
                return `
                    <div class="bar-group">
                        <div class="bar-pair">
                            <div class="v-bar income" style="height:${incH}%" data-value="+${this.formatCurrency(v.inc)}"></div>
                            <div class="v-bar expense" style="height:${expH}%" data-value="-${this.formatCurrency(v.exp)}"></div>
                        </div>
                        <span class="bar-label">${label}</span>
                    </div>
                `;
            }).join('');
        },

        purgeOldData() {
            if (!confirm("Sei sicuro di voler eliminare DEFINITIVAMENTE tutti i movimenti precedenti al 2026? Questa operazione non può essere annullata.")) return;

            const before = Store.data.transactions.length;
            Store.data.transactions = Store.data.transactions.filter(t => {
                const d = new Date(t.date);
                return d.getFullYear() >= 2026;
            });
            const after = Store.data.transactions.length;

            Store.save();
            Store.recalculateBalances();
            UI.updateAll();

            alert(`Pulizia completata! Rimosse ${before - after} transazioni legacy.`);
        },

        renderCategoryChart(trxs) {
            const donut = document.getElementById('category-pie');
            const legend = document.getElementById('category-chart');
            if (!donut || !legend) return;
            const totals = {};
            trxs.filter(t => t.type === 'expense').forEach(t => {
                totals[t.category] = (totals[t.category] || 0) + t.amount;
            });
            const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
            const total = sorted.reduce((s, [, v]) => s + v, 0);
            if (total === 0) {
                donut.style.background = '#eee';
                legend.innerHTML = '<p>Nessun dato</p>';
                return;
            }
            const colors = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#34495e'];
            let current = 0;
            const segments = sorted.map(([id, val], i) => {
                const start = current;
                const end = current + (val / total * 100);
                current = end;
                return `${colors[i % colors.length]} ${start}% ${end}% `;
            }).join(', ');
            donut.style.setProperty('--pie-segments', segments);
            legend.innerHTML = sorted.map(([id, val], i) => {
                const cat = Store.data.categories.find(c => c.id === id);
                const perc = total > 0 ? (val / total * 100).toFixed(1) : 0;
                return `
                    <div class="legend-item">
                        <div class="legend-info">
                            <div class="legend-dot" style="background:${colors[i % colors.length]}"></div>
                            <span class="legend-name">${cat?.name || 'Altro'} <small style="color:#94a3b8; font-weight:400; margin-left:4px;">${perc}%</small></span>
                        </div>
                        <span class="legend-value">${this.formatCurrency(val)}</span>
                    </div>
                `;
            }).join('');
        },


        editContract(id) {
            const c = Store.data.contracts.find(ct => ct.id === id);
            if (!c) return;
            document.getElementById('contract-id').value = c.id;
            document.getElementById('contract-prop-name').value = c.propName;
            document.getElementById('contract-tenant-name').value = c.tenantName;
            document.getElementById('contract-rent').value = c.rentAmount;
            document.getElementById('contract-type').value = c.type;
            document.getElementById('contract-start').value = c.startDate;
            document.getElementById('contract-end').value = c.endDate || '';
            document.getElementById('modal-contract-title').textContent = 'Modifica Contratto';
            document.getElementById('modal-property').classList.remove('hidden');
        },

        manageArrears(contractId) {
            const contract = Store.data.contracts.find(c => c.id === contractId);
            if (!contract) return;

            const stats = Store.getContractStats(contractId);
            const modal = document.getElementById('modal-arrears');

            // Aggiorna Intestazione
            document.getElementById('rent-ledger-title').textContent = `Storico Inquilino: ${contract.tenantName} (${contract.propName})`;
            document.getElementById('rent-total-arrears').textContent = this.formatCurrency(stats.arrears);
            document.getElementById('due-contract-id').value = contractId;

            // Costruisci il Mastro (Unione di Dues e Allocations)
            const ledger = [];
            stats.dues.forEach(d => ledger.push({ ...d, sortDate: d.referenceMonth + '-01', entryType: 'DUE' }));
            stats.allocations.forEach(a => {
                const trx = Store.data.transactions.find(t => t.id === a.transactionId);
                ledger.push({ ...a, sortDate: trx ? trx.date : a.referenceMonth + '-15', entryType: 'ALLOCATION', trxDesc: trx ? trx.description : '' });
            });

            // Ordina mastro decrescente
            ledger.sort((a, b) => b.sortDate.localeCompare(a.sortDate));

            const listEl = document.getElementById('rent-ledger-list');
            if (ledger.length === 0) {
                listEl.innerHTML = '<div style="text-align:center; padding:30px; color:#94a3b8;"><i class="fas fa-history" style="font-size:2rem; margin-bottom:10px; opacity:0.3;"></i><p>Ancora nessun movimento in questo storico.</p></div>';
            } else {
                listEl.innerHTML = ledger.map(item => {
                    const isDue = item.entryType === 'DUE';
                    return `
    <div style="padding:12px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; background:${isDue ? '#fffcf0' : '#f0fdf4'};">
                            <div style="display:flex; align-items:center; gap:12px;">
                                <div style="width:40px; height:40px; border-radius:20px; display:flex; align-items:center; justify-content:center; background:${isDue ? '#fef3c7' : '#dcfce7'}; color:${isDue ? '#d97706' : '#16a34a'};">
                                    <i class="fas ${isDue ? 'fa-file-invoice-dollar' : 'fa-hand-holding-usd'}" style="font-size: 1.35rem;"></i>
                                </div>
                                <div>
                                    <div style="font-weight:700; color:#1e293b; font-size: 1.3rem;">${isDue ? 'Canone da Pagare (Debito)' : 'Pagamento Ricevuto'}</div>
                                    <div style="font-size: 1.3rem; color:#64748b;">Mese: ${item.referenceMonth} ${!isDue && item.trxDesc ? ' - ' + item.trxDesc : ''}</div>
                                </div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-weight:800; font-size: 1.45rem; color:${isDue ? '#e11d48' : '#16a34a'};">
                                    ${isDue ? '+' : '-'}${this.formatCurrency(isDue ? item.amount : item.allocatedAmount)}
                                </div>
                                ${isDue ? `<button onclick="UI.deleteDue('${item.id}', '${contractId}')" style="background:#fee2e2; border:none; color:#ef4444; padding:4px 10px; border-radius:6px; cursor:pointer; font-size: 1.3rem; font-weight:700; margin-top:5px;">ELIMINA</button>` : ''}
                            </div>
                        </div>
    `;
                }).join('');
            }

            modal.classList.remove('hidden');
        },

        deleteDue(dueId, contractId) {
            if (confirm('Eliminare questo debito? Le transazioni non verranno toccate.')) {
                Store.deleteDue(dueId);
                this.manageArrears(contractId);
                this.renderProperties();
            }
        },

        openPayRentModal(contractId) {
            const contract = Store.data.contracts.find(c => c.id === contractId);
            if (!contract) return;

            document.getElementById('rent-property-id').value = contractId;
            document.getElementById('rent-amount').value = contract.rentAmount;

            const today = new Date().toISOString().split('T')[0];
            document.getElementById('rent-date-paid').value = today;
            document.getElementById('rent-date-ref').value = today;

            const accountSelect = document.getElementById('rent-account-id');
            if (accountSelect) {
                accountSelect.innerHTML = Store.data.accounts.map(acc =>
                    `<option value="${acc.id}">${acc.name} (${this.formatCurrency(acc.balance)})</option>`
                ).join('');
            }

            document.getElementById('modal-pay-rent').classList.remove('hidden');
        },
        togglePropertyHistory(propertyId) {
            const historyEl = document.getElementById(`history-${propertyId}`);
            if (historyEl) {
                historyEl.classList.toggle('hidden');
            }
        },

        // --- CLEANUP MANAGER UI (Bonifica Dati) ---
        renderCleanupManager() {
            const candidates = Store.getCleanupCandidates();

            let overlay = document.getElementById('cleanup-overlay');
            if (overlay) overlay.remove();

            overlay = document.createElement('div');
            overlay.id = 'cleanup-overlay';
            overlay.className = 'modal-overlay';
            overlay.style = `
position: fixed; top: 0; left: 0; width: 100%; height: 100%;
background: rgba(0, 0, 0, 0.8); z-index: 9999; display: flex;
align-items: center; justify-content: center; padding: 20px;
`;

            const card = document.createElement('div');
            card.style = `
background: white; width: 100%; max-width: 800px; max-height: 90vh;
border-radius: 16px; display: flex; flex-direction: column; overflow: hidden;
box-shadow: 0 20px 25px - 5px rgba(0, 0, 0, 0.1); border: 1px solid #e2e8f0;
`;

            let html = `
    <div style="padding:20px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center; background:#f8fafc;">
                    <div>
                        <h3 style="margin:0; color:#1e293b; font-family:inherit;">Bonifica Movimenti Alloggi</h3>
                        <p style="margin:5px 0 0; font-size: 1.4rem; color:#64748b;">Seleziona i test o i duplicati da eliminare chirugicamente.</p>
                    </div>
                    <button onclick="window.closeCleanup()" style="background:none; border:none; font-size:1.5rem; color:#94a3b8; cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>
                
                <div style="padding:15px; background:#fff7ed; border-bottom:1px solid #ffedd5; font-size: 1.4rem; color:#9a3412; display:flex; align-items:center;">
                    <i class="fas fa-exclamation-triangle" style="margin-right:10px;"></i>
                    L'eliminazione è definitiva e ricalcolerà immediatamente i saldi dei conti.
                </div>

                <div style="flex:1; overflow-y:auto; padding:20px;">
                    <table style="width:100%; border-collapse:collapse; font-size: 1.3rem;">
                        <thead style="position:sticky; top:0; background:white; text-align:left; z-index:10;">
                            <tr style="border-bottom:2px solid #f1f5f9;">
                                <th style="padding:10px; width:40px;"><input type="checkbox" onchange="window.selectAllCleanup(this.checked)"></th>
                                <th style="padding:10px; color:#64748b;">Data</th>
                                <th style="padding:10px; color:#64748b;">Descrizione</th>
                                <th style="padding:10px; color:#64748b; text-align:right;">Importo</th>
                                <th style="padding:10px; color:#64748b;">Conto</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${candidates.map(t => {
                const acc = Store.data.accounts.find(a => a.id === t.accountId);
                return `
                                    <tr class="cleanup-row" data-id="${t.id}" onclick="window.toggleCleanupSelect('${t.id}')" style="border-bottom:1px solid #f1f5f9; cursor:pointer; transition:background 0.2s;">
                                        <td style="padding:12px 10px;" onclick="event.stopPropagation()"><input type="checkbox" class="row-check"></td>
                                        <td style="padding:12px 10px; white-space:nowrap; font-size: 1.4rem;">${new Date(t.date).toLocaleDateString('it-IT')}</td>
                                        <td style="padding:12px 10px;">
                                            <div style="font-weight:600; color:#1e293b; font-size: 1.3rem;">${t.description}</div>
                                            <div style="font-size: 1.3rem; color:#94a3b8;">ID: ${t.id}</div>
                                        </td>
                                        <td style="padding:12px 10px; text-align:right; font-weight:700; color:${t.type === 'income' ? '#22c55e' : '#ef4444'}; font-size: 1.35rem;">
                                            ${this.formatCurrency(t.amount)}
                                        </td>
                                        <td style="padding:12px 10px; font-size: 1.4rem; color:#64748b;">${acc ? acc.name : '-'}</td>
                                    </tr>
                                `;
            }).join('')}
                        </tbody>
                    </table>
                    ${candidates.length === 0 ? '<div style="text-align:center; padding:40px; color: #94a3b8;"><i class="fas fa-check-circle" style="font-size:2rem; margin-bottom:10px;"></i><p>Nessun movimento sospetto trovato.</p></div>' : ''}
                </div>

                <div style="padding:20px; border-top:1px solid #eee; background:#f8fafc; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size: 1.4rem; color:#64748b;">${candidates.length} movimenti trovati</span>
                    <div>
                        <button onclick="window.closeCleanup()" style="padding:10px 20px; border-radius:8px; border:1px solid #e2e8f0; background:white; cursor:pointer; margin-right:10px; font-weight:600;">Annulla</button>
                        <button onclick="window.bulkDeleteCleanup()" style="padding:10px 25px; border-radius:8px; border:none; background:#ef4444; color:white; font-weight:700; cursor:pointer; box-shadow:0 4px 6px -1px rgba(239, 68, 68, 0.2);">ELIMINA SELEZIONATI</button>
                    </div>
                </div>

                <style>
                    .cleanup-row:hover { background: #f8fafc !important; }
                    .cleanup-row.selected { background: #fee2e2 !important; }
                    .cleanup-row.selected .row-check { accent-color: #ef4444; }
                </style>
`;
            card.innerHTML = html;
            overlay.appendChild(card);
            document.body.appendChild(overlay);
        },

        // Render Category Report
        renderCategoryReport() {
            const container = document.getElementById('category-report-container');
            if (!container) return;

            const trxs = this.getFilteredTransactions();

            // Group by category
            const categoryTotals = {};
            trxs.forEach(t => {
                if (!t.category) return;
                if (!categoryTotals[t.category]) {
                    categoryTotals[t.category] = { income: 0, expense: 0 };
                }
                if (t.type === 'income') {
                    categoryTotals[t.category].income += parseFloat(t.amount) || 0;
                } else if (t.type === 'expense') {
                    categoryTotals[t.category].expense += parseFloat(t.amount) || 0;
                }
            });

            if (Object.keys(categoryTotals).length === 0) {
                container.innerHTML = '<p style="text-align: center; color: #94a3b8; font-size: 1.4rem; padding: 10px;">Nessun dato</p>';
                return;
            }

            const html = Object.entries(categoryTotals)
                .sort((a, b) => (b[1].expense + b[1].income) - (a[1].expense + a[1].income))
                .map(([catId, totals]) => {
                    const cat = Store.data.categories.find(c => c.id === catId);
                    const catName = cat ? cat.name : 'Sconosciuta';
                    const catIcon = cat ? cat.icon : 'fa-tag';
                    const catColor = cat ? cat.color : '#666';

                    const total = totals.income - totals.expense;
                    const isPositive = total >= 0;

                    return `
    <div class="report-item">
                        <div class="report-item-name">
                            <i class="fas ${catIcon}" style="color: ${catColor};"></i>
                            ${catName}
                        </div>
                        <div class="report-item-amount ${isPositive ? 'income' : 'expense'}">
                            ${isPositive ? '+' : ''}${this.formatCurrency(total)}
                        </div>
                    </div>
    `;
                }).join('');

            container.innerHTML = html;
        },

        // Implement CSV Export
        exportToCSV() {
            const trxs = this.getFilteredTransactions();
            if (!trxs || trxs.length === 0) {
                alert("Nessun movimento da esportare con i filtri attuali.");
                return;
            }

            // CSV Header
            let csvContent = "data:text/csv;charset=utf-8,";
            csvContent += "Data;Tipo;Categoria;Conto;Importo;Note\n"; // Using semicolon for Excel compatibility in IT

            // CSV Rows
            trxs.forEach(t => {
                const date = new Date(t.date).toLocaleDateString('it-IT');
                const type = t.type === 'income' ? 'Entrata' : (t.type === 'expense' ? 'Uscita' : 'Trasferimento');

                const cat = Store.data.categories.find(c => c.id === t.category);
                const catName = cat ? cat.name : (t.type === 'transfer' ? 'Giroconto' : 'Altro');

                const acc = Store.data.accounts.find(a => a.id === t.accountId);
                const accName = acc ? acc.name : 'N/D';

                const amountValue = parseFloat(t.amount) || 0;
                const amount = this.formatCurrency(amountValue);
                const note = (t.description || '').replace(/;/g, ' ').replace(/\n/g, ' ');

                csvContent += `${date};${type};${catName};${accName};${amount};${note}\n`;
            });

            // Create download link
            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            const fileName = `movimenti_export_${new Date().toISOString().slice(0, 10)}.csv`;
            link.setAttribute("download", fileName);
            document.body.appendChild(link);

            link.click();
            document.body.removeChild(link);
        }
    };

    // --- ICON PICKER ---
    const ICONS_LIST = [
        // Food & Drink (Orange/Yellow)
        { icon: 'fa-utensils', color: '#e67e22' }, { icon: 'fa-shopping-cart', color: '#f1c40f' }, { icon: 'fa-coffee', color: '#6d4c41' },
        { icon: 'fa-pizza-slice', color: '#ff9800' }, { icon: 'fa-hamburger', color: '#ffc107' }, { icon: 'fa-ice-cream', color: '#ff80ab' },
        { icon: 'fa-beer', color: '#ffb300' }, { icon: 'fa-wine-glass', color: '#d32f2f' }, { icon: 'fa-cocktail', color: '#00bcd4' },
        { icon: 'fa-apple-alt', color: '#f44336' }, { icon: 'fa-carrot', color: '#ff9800' }, { icon: 'fa-cookie', color: '#795548' },
        { icon: 'fa-shopping-basket', color: '#4caf50' }, { icon: 'fa-fish', color: '#03a9f4' }, { icon: 'fa-egg', color: '#eee' },
        { icon: 'fa-bacon', color: '#e74c3c' }, { icon: 'fa-bread-slice', color: '#dcb189' }, { icon: 'fa-cheese', color: '#ffc107' },
        { icon: 'fa-candy-cane', color: '#f44336' }, { icon: 'fa-hotdog', color: '#ff5722' },

        // Home & Utilities (Blue/Cyan)
        { icon: 'fa-home', color: '#3498db' }, { icon: 'fa-lightbulb', color: '#f1c40f' }, { icon: 'fa-wifi', color: '#3498db' },
        { icon: 'fa-faucet', color: '#2196f3' }, { icon: 'fa-fire', color: '#ff5722' }, { icon: 'fa-plug', color: '#ffeb3b' },
        { icon: 'fa-trash', color: '#95a5a6' }, { icon: 'fa-couch', color: '#673ab7' }, { icon: 'fa-bed', color: '#3f51b5' },
        { icon: 'fa-shower', color: '#03a9f4' }, { icon: 'fa-toilet', color: '#9e9e9e' }, { icon: 'fa-hammer', color: '#795548' },
        { icon: 'fa-wrench', color: '#757575' }, { icon: 'fa-tools', color: '#7f8c8d' }, { icon: 'fa-broom', color: '#2196f3' },
        { icon: 'fa-key', color: '#ffc107' }, { icon: 'fa-door-open', color: '#795548' }, { icon: 'fa-tv', color: '#2c3e50' },

        // Transport (Grey/Slate)
        { icon: 'fa-car', color: '#7f8c8d' }, { icon: 'fa-bus', color: '#e67e22' }, { icon: 'fa-plane', color: '#2980b9' },
        { icon: 'fa-bicycle', color: '#27ae60' }, { icon: 'fa-gas-pump', color: '#34495e' }, { icon: 'fa-subway', color: '#c0392b' },
        { icon: 'fa-train', color: '#2c3e50' }, { icon: 'fa-ship', color: '#3498db' }, { icon: 'fa-motorcycle', color: '#16a085' },
        { icon: 'fa-taxi', color: '#f1c40f' }, { icon: 'fa-parking', color: '#2980b9' }, { icon: 'fa-road', color: '#7f8c8d' },

        // Health & Pets (Red/Pink/Orange)
        { icon: 'fa-heartbeat', color: '#e74c3c' }, { icon: 'fa-pills', color: '#3498db' }, { icon: 'fa-hospital', color: '#e74c3c' },
        { icon: 'fa-tooth', color: '#3498db' }, { icon: 'fa-medkit', color: '#e74c3c' }, { icon: 'fa-stethoscope', color: '#2c3e50' },
        { icon: 'fa-paw', color: '#d35400' }, { icon: 'fa-dog', color: '#ff9800' }, { icon: 'fa-cat', color: '#795548' },
        { icon: 'fa-bone', color: '#9e9e9e' }, { icon: 'fa-dove', color: '#3498db' }, { icon: 'fa-spider', color: '#000' },

        // Shopping & Fashion (Purple/Magenta)
        { icon: 'fa-tshirt', color: '#9b59b6' }, { icon: 'fa-shopping-bag', color: '#e91e63' }, { icon: 'fa-gem', color: '#00bcd4' },
        { icon: 'fa-shopping-basket', color: '#4caf50' }, { icon: 'fa-store', color: '#3f51b5' }, { icon: 'fa-shoe-prints', color: '#795548' },
        { icon: 'fa-gift', color: '#e74c3c' }, { icon: 'fa-crown', color: '#ffc107' }, { icon: 'fa-glasses', color: '#333' },

        // Leisure & Fun (Various)
        { icon: 'fa-gamepad', color: '#e74c3c' }, { icon: 'fa-music', color: '#9b59b6' }, { icon: 'fa-ticket-alt', color: '#e67e22' },
        { icon: 'fa-glass-cheers', color: '#f1c40f' }, { icon: 'fa-palette', color: '#ff9800' }, { icon: 'fa-movie', color: '#000000' },
        { icon: 'fa-camera', color: '#424242' }, { icon: 'fa-theater-masks', color: '#9c27b0' }, { icon: 'fa-dice', color: '#e74c3c' },
        { icon: 'fa-swimming-pool', color: '#03a9f4' }, { icon: 'fa-football-ball', color: '#795548' }, { icon: 'fa-volleyball-ball', color: '#ffeb3b' },
        { icon: 'fa-mountain', color: '#27ae60' }, { icon: 'fa-sun', color: '#ffc107' }, { icon: 'fa-umbrella', color: '#e91e63' },

        // Tech & Office (Slate/Grey)
        { icon: 'fa-laptop', color: '#34495e' }, { icon: 'fa-briefcase', color: '#8e44ad' }, { icon: 'fa-graduation-cap', color: '#2980b9' },
        { icon: 'fa-book', color: '#d35400' }, { icon: 'fa-pencil-alt', color: '#f39c12' }, { icon: 'fa-chart-line', color: '#27ae60' },
        { icon: 'fa-copy', color: '#7f8c8d' }, { icon: 'fa-print', color: '#2c3e50' }, { icon: 'fa-envelope', color: '#3498db' },
        { icon: 'fa-mobile-alt', color: '#333' }, { icon: 'fa-database', color: '#e74c3c' }, { icon: 'fa-code', color: '#27ae60' },
        { icon: 'fa-folder', color: '#666' }, { icon: 'fa-tag', color: '#666' },

        // Money & Finance (Green/Gold)
        { icon: 'fa-coins', color: '#f1c40f' }, { icon: 'fa-wallet', color: '#27ae60' }, { icon: 'fa-credit-card', color: '#2980b9' },
        { icon: 'fa-money-bill-wave', color: '#27ae60' }, { icon: 'fa-piggy-bank', color: '#e91e63' }, { icon: 'fa-university', color: '#2c3e50' },
        { icon: 'fa-receipt', color: '#9e9e9e' }, { icon: 'fa-percentage', color: '#c0392b' }, { icon: 'fa-donate', color: '#2196f3' },

        // Travel (Various)
        { icon: 'fa-map-marked-alt', color: '#2ecc71' }, { icon: 'fa-luggage-cart', color: '#e67e22' }, { icon: 'fa-passport', color: '#2980b9' },
        { icon: 'fa-hotel', color: '#3498db' }, { icon: 'fa-route', color: '#27ae60' }, { icon: 'fa-landmark', color: '#795548' },

        // Nature & Science (Green/Purple)
        { icon: 'fa-tree', color: '#4caf50' }, { icon: 'fa-leaf', color: '#8bc34a' }, { icon: 'fa-seedling', color: '#4caf50' },
        { icon: 'fa-vial', color: '#9c27b0' }, { icon: 'fa-dna', color: '#e91e63' }, { icon: 'fa-atom', color: '#03a9f4' },
        { icon: 'fa-brain', color: '#ff80ab' }, { icon: 'fa-meteor', color: '#f39c12' }, { icon: 'fa-cloud', color: '#3498db' }
    ];

    const ICON_KEYWORDS = {
        'pizza': 'fa-pizza-slice', 'hamburger': 'fa-hamburger', 'panino': 'fa-hamburger', 'cibo': 'fa-utensils', 'ristorante': 'fa-utensils',
        'cena': 'fa-utensils', 'pranzo': 'fa-utensils', 'spesa': 'fa-shopping-cart', 'market': 'fa-shopping-cart', 'supermercato': 'fa-shopping-cart',
        'caffè': 'fa-coffee', 'colazione': 'fa-coffee', 'bar': 'fa-glass-cheers', 'birra': 'fa-beer', 'vino': 'fa-wine-glass', 'cocktail': 'fa-cocktail',
        'casa': 'fa-home', 'affitto': 'fa-home', 'luce': 'fa-lightbulb', 'bolletta': 'fa-file-invoice-dollar', 'gas': 'fa-gas-pump', 'acqua': 'fa-faucet',
        'internet': 'fa-wifi', 'fibra': 'fa-wifi', 'telefono': 'fa-mobile-alt', 'cellulare': 'fa-mobile-alt', 'rfiuti': 'fa-trash', 'spazzatura': 'fa-trash',
        'auto': 'fa-car', 'macchina': 'fa-car', 'benzina': 'fa-gas-pump', 'carburante': 'fa-gas-pump', 'metano': 'fa-gas-pump', 'parcheggio': 'fa-parking', 'mezzi': 'fa-bus',
        'treno': 'fa-train', 'bus': 'fa-bus', 'volo': 'fa-plane', 'viaggio': 'fa-map-marked-alt', 'viaggi': 'fa-map-marked-alt', 'hotel': 'fa-hotel', 'vacanza': 'fa-umbrella-beach',
        'salute': 'fa-heartbeat', 'medico': 'fa-user-md', 'dentista': 'fa-tooth', 'farmacia': 'fa-pills', 'medicine': 'fa-pills', 'sport': 'fa-dumbbell',
        'palestra': 'fa-dumbbell', 'calcio': 'fa-soccer-ball', 'piscina': 'fa-swimming-pool', 'cane': 'fa-dog', 'gatto': 'fa-cat', 'animale': 'fa-paw',
        'regalo': 'fa-gift', 'festa': 'fa-glass-cheers', 'cinema': 'fa-movie', 'film': 'fa-tv', 'netflix': 'fa-tv', 'musica': 'fa-music',
        'gioco': 'fa-gamepad', 'ps5': 'fa-gamepad', 'xbox': 'fa-gamepad', 'lavoro': 'fa-briefcase', 'stipendio': 'fa-money-bill-wave',
        'bonus': 'fa-piggy-bank', 'soldi': 'fa-coins', 'banca': 'fa-university', 'bancomat': 'fa-credit-card', 'carta': 'fa-credit-card',
        'vestiti': 'fa-tshirt', 'abbigliamento': 'fa-tshirt', 'scarpe': 'fa-shoe-prints', 'shopping': 'fa-shopping-bag', 'estetica': 'fa-spa', 'barbiere': 'fa-cut',
        'capelli': 'fa-cut', 'parrucchiere': 'fa-cut', 'scuola': 'fa-graduation-cap', 'università': 'fa-graduation-cap', 'libro': 'fa-book', 'cancelleria': 'fa-pencil-alt',
        'computer': 'fa-laptop', 'tech': 'fa-laptop', 'amazon': 'fa-shopping-bag', 'pulizie': 'fa-broom', 'riparazione': 'fa-wrench',
        'ferramenta': 'fa-hammer', 'giardino': 'fa-leaf', 'piante': 'fa-seedling', 'assicurazione': 'fa-shield-alt', 'tasse': 'fa-percentage'
    };
    let pickerState = { mode: null, targetId: null, groupId: null, icon: 'fa-tag' };
    const UI_PICKER = {
        open(mode, targetId, groupId) {
            pickerState = { mode, targetId, groupId, icon: 'fa-tag' };
            const titleEl = document.querySelector('#modal-icon-picker h2');
            const nameInput = document.getElementById('new-cat-name'); nameInput.value = '';
            const initialBalInput = document.getElementById('initial-balance'); initialBalInput.value = '';
            const balanceRow = document.getElementById('initial-balance-row');

            // Hide/Show balance row only for accounts
            const isAccount = mode === 'create-acc' || mode === 'edit-acc';
            if (balanceRow) balanceRow.style.display = isAccount ? 'block' : 'none';

            if (mode === 'create-acc') { titleEl.textContent = 'Nuovo Conto'; pickerState.icon = 'fa-university'; }
            else if (mode === 'edit-acc') {
                titleEl.textContent = 'Modifica Conto';
                const a = Store.data.accounts.find(x => x.id == targetId);
                if (a) {
                    nameInput.value = a.name;
                    pickerState.icon = a.icon;
                    initialBalInput.value = a.initialBalance || 0;
                }
            }
            else if (mode === 'create-group') { titleEl.textContent = 'Nuova Cat. Principale'; pickerState.icon = 'fa-folder'; }
            else if (mode === 'edit-group') { titleEl.textContent = 'Modifica Cat. Principale'; const g = Store.data.groups.find(x => x.id == targetId); if (g) { nameInput.value = g.name; pickerState.icon = g.icon; } }
            else if (mode === 'create-cat') { titleEl.textContent = 'Nuova Sottocategoria'; pickerState.icon = 'fa-tag'; }
            else if (mode === 'edit-cat') { titleEl.textContent = 'Modifica Sottocategoria'; const c = Store.data.categories.find(x => x.id == targetId); if (c) { nameInput.value = c.name; pickerState.icon = c.icon; } }
            this.renderGrid(); document.getElementById('modal-icon-picker').classList.remove('hidden');
        },
        renderGrid() {
            const grid = document.getElementById('icons-grid');
            // Sort to put selected at top
            const sortedList = [...ICONS_LIST].sort((a, b) => (b.icon === pickerState.icon) - (a.icon === pickerState.icon));
            grid.innerHTML = sortedList.map(item => `
    <div class="icon-option ${item.icon === pickerState.icon ? 'selected' : ''}"
onclick="window.setPickerIcon('${item.icon}')"
style="color:${item.color}; border-color:${item.icon === pickerState.icon ? item.color : '#eee'}; background:${item.icon === pickerState.icon ? item.color + '10' : 'transparent'};">
    <i class="fas ${item.icon}"></i>
                </div>
    `).join('');
        },
        handleNameInput(e) {
            const val = e.target.value.toLowerCase().trim();
            if (!val) return;
            for (const kw in ICON_KEYWORDS) {
                if (val.includes(kw)) {
                    const icon = ICON_KEYWORDS[kw];
                    if (pickerState.icon !== icon) {
                        pickerState.icon = icon;
                        this.renderGrid();
                    }
                    break;
                }
            }
        }
    };
    window.setPickerIcon = (icon) => { pickerState.icon = icon; UI_PICKER.renderGrid(); };

    // --- GLOBAL ACTIONS ---
    window.delTrx = (id) => { if (confirm('Eliminare?')) { Store.data.transactions = Store.data.transactions.filter(t => t.id != id); Store.recalculateBalances(); Store.save(); UI.updateAll(); } };
    window.delRec = (id) => { if (confirm('Eliminare ricorrenza?')) { Store.data.recurring = Store.data.recurring.filter(r => r.id != id); Store.save(); UI.updateAll(); } };
    window.editTrx = (id) => {
        const t = Store.data.transactions.find(x => x.id == id); if (!t) return;
        UI.editingId = id; document.getElementById('modal-title').textContent = 'Modifica Transazione';
        document.getElementById('amount').value = t.amount;
        document.getElementById('description').value = t.description;

        // Fix timezone issue: extract YYYY-MM-DD from ISO string
        const dateStr = t.date ? t.date.split('T')[0] : new Date().toISOString().split('T')[0];
        document.getElementById('date').value = dateStr;
        document.getElementById('account-id').value = t.accountId;

        // Update category search field
        const cat = Store.data.categories.find(c => c.id === t.category);
        if (cat) {
            document.getElementById('category-search').value = cat.name;
            document.getElementById('category').value = cat.id;
            const iconWrapper = document.getElementById('selected-cat-icon-wrapper');
            if (iconWrapper) {
                iconWrapper.innerHTML = `<i class="fas ${cat.icon}" style="color:${cat.color || '#666'};"></i>`;
            }
        }

        document.querySelector(`.type-tab[data-type="${t.type}"]`)?.click();
        document.getElementById('modal').classList.remove('hidden');
    };
    window.editRec = (id) => {
        const r = Store.data.recurring.find(x => x.id == id); if (!r) return;
        document.getElementById('rec-id').value = r.id;
        document.getElementById('rec-amount').value = r.amount;
        document.getElementById('rec-description').value = r.description;
        document.getElementById('rec-account-id').value = r.accountId;

        // Populate Category Search for Recurring
        const cat = Store.data.categories.find(c => c.id === r.categoryId);
        if (cat) {
            document.getElementById('rec-category-search').value = cat.name;
            document.getElementById('rec-category').value = cat.id;
            const iconWrapper = document.getElementById('rec-selected-cat-icon-wrapper');
            if (iconWrapper) {
                iconWrapper.innerHTML = `<i class="fas ${cat.icon}" style="color:${cat.color || '#666'};"></i>`;
            }
        } else {
            document.getElementById('rec-category-search').value = '';
            document.getElementById('rec-category').value = '';
            document.getElementById('rec-selected-cat-icon-wrapper').innerHTML = '<i class="fas fa-question-circle"></i>';
        }

        // Fix timezone issue
        const dateStr = r.nextDueDate ? r.nextDueDate.split('T')[0] : new Date().toISOString().split('T')[0];
        document.getElementById('rec-date').value = dateStr;

        document.getElementById('rec-repeat').checked = !!r.repeat;
        document.getElementById('modal-rec-title').textContent = 'Modifica Ricorrenza';
        document.getElementById('modal-recurring').classList.remove('hidden');
    };
    window.removeCatBudget = (id) => {
        if (Store.data.budgetSettings?.categoryBudgets) {
            delete Store.data.budgetSettings.categoryBudgets[id];
            UI.renderBucketBudgetSettings();
        }
    };

    let tempBudget = { id: '', startDate: '', endDate: '', totalAmount: 0, categoryBudgets: {} };

    window.editBudgetDefinition = (id) => {
        const b = (Store.data.budgets || []).find(x => x.id === id);
        if (!b) return;
        tempBudget = JSON.parse(JSON.stringify(b));
        document.getElementById('budget-id').value = tempBudget.id;
        document.getElementById('budget-start-date').value = tempBudget.startDate;
        document.getElementById('budget-end-date').value = tempBudget.endDate;
        document.getElementById('budget-total-amount').value = tempBudget.totalAmount;
        document.getElementById('modal-budget-settings').classList.remove('hidden');
        UI.renderBucketBudgetSettings(tempBudget.categoryBudgets);
    };

    window.deleteBudgetDefinition = (id) => {
        if (confirm('Eliminare questa definizione di budget?')) {
            Store.data.budgets = (Store.data.budgets || []).filter(b => b.id !== id);
            Store.save(); UI.updateAll();
        }
    };

    window.removeCatBudgetLocal = (id) => {
        delete tempBudget.categoryBudgets[id];
        UI.renderBucketBudgetSettings(tempBudget.categoryBudgets);
    };
    window.UI_REFRESH = UI.updateAll.bind(UI);

    Store.init();

    // --- EVENT LISTENERS ---
    document.getElementById('new-cat-name')?.addEventListener('input', (e) => UI_PICKER.handleNameInput(e));

    // Category Search Functionality
    // --- REUSABLE CATEGORY SEARCH SETUP ---
    function setupCategorySearch(searchInputId, dropdownId, hiddenInputId, iconWrapperId, containerId) {
        const searchInput = document.getElementById(searchInputId);
        const dropdown = document.getElementById(dropdownId);
        const hiddenInput = document.getElementById(hiddenInputId);
        const iconWrapper = document.getElementById(iconWrapperId);

        if (!searchInput || !dropdown) return;

        function populate(term = '') {
            const t = term.toLowerCase();
            let html = '';
            Store.data.groups.forEach(group => {
                const groupCats = Store.data.categories.filter(c => c.groupId === group.id);
                const filtered = groupCats.filter(c => c.name.toLowerCase().includes(t));
                if (filtered.length > 0) {
                    html += `<div style="padding:8px 12px; background:#f5f5f5; font-weight:600; font-size: 1.4rem; color:#666; border-bottom:1px solid #eee;">${group.name}</div>`;
                    filtered.forEach(cat => {
                        html += `
                            <div class="category-option" data-id="${cat.id}" data-name="${cat.name}" data-icon="${cat.icon}" data-color="${cat.color || '#666'}"
                            style="padding:10px 12px; cursor:pointer; display:flex; align-items:center; border-bottom:1px solid #f5f5f5; transition:background 0.2s;"
                            onmouseover="this.style.background='#f9f9f9'" onmouseout="this.style.background='white'">
                                <i class="fas ${cat.icon}" style="margin-right:10px; width:20px; color:${cat.color || '#666'}; text-align:center;"></i>
                                <span>${cat.name}</span>
                            </div>`;
                    });
                }
            });
            if (html === '') html = '<div style="padding:15px; text-align:center; color:#999; font-size: 1.3rem;">Nessuna categoria trovata</div>';
            dropdown.innerHTML = html;
            dropdown.classList.remove('hidden');

            dropdown.querySelectorAll('.category-option').forEach(opt => {
                opt.addEventListener('click', () => {
                    hiddenInput.value = opt.dataset.id;
                    searchInput.value = opt.dataset.name;
                    dropdown.classList.add('hidden');
                    if (iconWrapper) iconWrapper.innerHTML = `<i class="fas ${opt.dataset.icon}" style="color:${opt.dataset.color};"></i>`;
                });
            });
        }

        searchInput.addEventListener('focus', () => populate(searchInput.value));
        searchInput.addEventListener('input', (e) => populate(e.target.value));

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#' + containerId)) {
                dropdown.classList.add('hidden');
            }
        });
    }

    // Initialize logic for Transaction Modal
    setupCategorySearch('category-search', 'category-dropdown', 'category', 'selected-cat-icon-wrapper', 'category-search-container');
    // Initialize logic for Recurring Modal
    setupCategorySearch('rec-category-search', 'rec-category-dropdown', 'rec-category', 'rec-selected-cat-icon-wrapper', 'rec-category-search-container');

    // Auto-categorize transaction based on description
    document.getElementById('description')?.addEventListener('input', (e) => {
        const val = e.target.value.toLowerCase().trim();
        if (val.length < 3) return;

        let foundIcon = null;
        for (const kw in ICON_KEYWORDS) {
            if (val.includes(kw)) { foundIcon = ICON_KEYWORDS[kw]; break; }
        }

        if (foundIcon) {
            // Find a category that uses this icon
            const match = Store.data.categories.find(c => c.icon === foundIcon);
            if (match) {
                const catSelect = document.getElementById('category');
                if (catSelect && catSelect.value !== match.id) {
                    catSelect.value = match.id;
                    // Optional: Visual feedback like a brief highlight
                    catSelect.style.outline = '2px solid var(--primary-color)';
                    setTimeout(() => catSelect.style.outline = 'none', 1000);
                }
            }
        }
    });

    document.body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]'); if (btn) window.switchTab(btn.dataset.tab);

        // Target multiple action button classes: .action-btn, .t-action-btn, .action-btn-styled
        const actionBtn = e.target.closest('.action-btn, .t-action-btn, .action-btn-styled');

        if (actionBtn) {
            const { action, id, groupId } = actionBtn.dataset;
            if (action === 'edit-account') UI_PICKER.open('edit-acc', id);
            else if (action === 'delete-account' && confirm('Eliminare conto?')) { Store.data.accounts = Store.data.accounts.filter(a => a.id != id); Store.save(); UI.updateAll(); }
            else if (action === 'add-category') UI_PICKER.open('create-cat', null, groupId);
            else if (action === 'edit-category') UI_PICKER.open('edit-cat', id);
            else if (action === 'delete-category' && confirm('Eliminare?')) { Store.data.categories = Store.data.categories.filter(c => c.id != id); Store.save(); UI.updateAll(); }
            else if (action === 'edit-group') UI_PICKER.open('edit-group', id);
            else if (action === 'delete-group' && confirm('Eliminare?')) { Store.data.groups = Store.data.groups.filter(g => g.id != id); Store.save(); UI.updateAll(); }
            else if (action === 'quick-add') {
                UI.editingId = null;
                document.getElementById('transaction-form').reset();

                // Set Category
                const cat = Store.data.categories.find(c => c.id === id);
                if (cat) {
                    document.getElementById('category-search').value = cat.name;
                    document.getElementById('category').value = cat.id;
                    const iconWrapper = document.getElementById('selected-cat-icon-wrapper');
                    if (iconWrapper) iconWrapper.innerHTML = `<i class="fas ${cat.icon}" style="color:${cat.color || '#666'};"></i>`;
                }

                document.getElementById('date').value = new Date().toISOString().split('T')[0];
                document.getElementById('modal-title').textContent = 'Aggiungi';
                document.getElementById('modal').classList.remove('hidden');
                document.getElementById('amount').focus();
            }
        }
        if (e.target.closest('#add-account-btn')) UI_PICKER.open('create-acc');
        if (e.target.closest('#add-group-btn')) UI_PICKER.open('create-group');
        if (e.target.closest('#add-recurring-btn')) {
            document.getElementById('recurring-form').reset();
            document.getElementById('rec-id').value = '';
            document.getElementById('rec-category').value = '';
            document.getElementById('rec-category-search').value = '';
            document.getElementById('rec-selected-cat-icon-wrapper').innerHTML = '<i class="fas fa-question-circle"></i>';

            // Fix timezone issue
            const today = new Date().toISOString().split('T')[0];
            document.getElementById('rec-date').value = today;

            document.getElementById('rec-repeat').checked = true;
            document.getElementById('modal-recurring').classList.remove('hidden');
        }
        if (e.target.closest('#add-contract-btn')) {
            document.getElementById('contract-form').reset();
            document.getElementById('contract-id').value = '';
            document.getElementById('modal-contract-title').textContent = 'Nuovo Contratto Affitto';
            document.getElementById('modal-property').classList.remove('hidden');
        }
    });

    document.getElementById('confirm-add-cat')?.addEventListener('click', () => {
        const name = document.getElementById('new-cat-name').value; if (!name) return alert('Inserisci un nome');
        const initialBalance = parseFloat(document.getElementById('initial-balance').value) || 0;
        const { mode, targetId, groupId, icon } = pickerState;
        const iconData = ICONS_LIST.find(i => i.icon === icon);
        const color = iconData ? iconData.color : '#666';

        if (mode === 'create-acc') Store.data.accounts.push({ id: 'acc_' + Date.now(), name, balance: 0, initialBalance, icon, color });
        else if (mode === 'edit-acc') { const a = Store.data.accounts.find(x => x.id == targetId); if (a) { a.name = name; a.icon = icon; a.color = color; a.initialBalance = initialBalance; } }
        else if (mode === 'create-group') Store.data.groups.push({ id: 'grp_' + Date.now(), name, icon, color });
        else if (mode === 'edit-group') { const g = Store.data.groups.find(x => x.id == targetId); if (g) { g.name = name; g.icon = icon; g.color = color; } }
        else if (mode === 'create-cat') Store.data.categories.push({ id: 'cat_' + Date.now(), groupId, name, icon, color });
        else if (mode === 'edit-cat') { const c = Store.data.categories.find(x => x.id == targetId); if (c) { c.name = name; c.icon = icon; c.color = color; } }

        Store.recalculateBalances();
        Store.save();
        UI.updateAll();
        document.getElementById('modal-icon-picker').classList.add('hidden');
    });

    document.getElementById('close-icon-picker')?.addEventListener('click', () => document.getElementById('modal-icon-picker').classList.add('hidden'));
    document.getElementById('close-modal-rec')?.addEventListener('click', () => document.getElementById('modal-recurring').classList.add('hidden'));
    document.getElementById('close-budget-settings')?.addEventListener('click', () => document.getElementById('modal-budget-settings').classList.add('hidden'));

    document.getElementById('add-cat-budget-btn')?.addEventListener('click', () => {
        const catId = document.getElementById('budget-cat-select').value;
        const amount = parseFloat(document.getElementById('budget-cat-amount').value) || 0;
        if (!catId || amount <= 0) return alert('Seleziona categoria e importo valido');
        tempBudget.categoryBudgets[catId] = amount;
        UI.renderBucketBudgetSettings(tempBudget.categoryBudgets);
        document.getElementById('budget-cat-amount').value = '';
    });

    document.getElementById('save-budget-settings')?.addEventListener('click', () => {
        const id = document.getElementById('budget-id').value;
        const startDate = document.getElementById('budget-start-date').value;
        const endDate = document.getElementById('budget-end-date').value;
        const totalAmount = parseFloat(document.getElementById('budget-total-amount').value) || 0;

        if (!startDate || !endDate) return alert('Seleziona entrambe le date');

        const catSum = Object.values(tempBudget.categoryBudgets || {}).reduce((s, amt) => s + amt, 0);
        if (totalAmount < catSum) {
            if (!confirm(`Il budget totale (${this.formatCurrency(totalAmount)}) è inferiore alla somma dei budget categoria (${this.formatCurrency(catSum)}). Procedere?`)) return;
        }

        const data = {
            id: id || 'b_' + Date.now(),
            startDate, endDate, totalAmount,
            categoryBudgets: tempBudget.categoryBudgets
        };

        if (!Store.data.budgets) Store.data.budgets = [];
        if (id) {
            const idx = Store.data.budgets.findIndex(b => b.id === id);
            if (idx !== -1) Store.data.budgets[idx] = data;
        } else {
            Store.data.budgets.push(data);
        }

        Store.save(); UI.updateAll();
        document.getElementById('modal-budget-settings').classList.add('hidden');
    });

    document.getElementById('recurring-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = document.getElementById('rec-id').value;

        // Fix timezone issue
        const recDateValue = document.getElementById('rec-date').value;
        const recDateISO = recDateValue ? new Date(recDateValue + 'T12:00:00').toISOString() : new Date().toISOString();

        const data = {
            amount: parseFloat(document.getElementById('rec-amount').value) || 0,
            description: document.getElementById('rec-description').value,
            categoryId: document.getElementById('rec-category').value,
            accountId: document.getElementById('rec-account-id').value,
            nextDueDate: recDateISO,
            repeat: document.getElementById('rec-repeat').checked
        };

        if (id) {
            const idx = Store.data.recurring.findIndex(r => r.id === id);
            if (idx !== -1) Store.data.recurring[idx] = { ...Store.data.recurring[idx], ...data };
        } else {
            Store.data.recurring.push({ id: 'rec_' + Date.now(), ...data });
        }

        Store.save();
        UI.updateAll();
        document.getElementById('modal-recurring').classList.add('hidden');
    });

    document.getElementById('add-btn')?.addEventListener('click', () => {
        UI.editingId = null;
        document.getElementById('transaction-form').reset();

        // Fix timezone issue: set today's date as YYYY-MM-DD string
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('date').value = today;

        // Reset category search
        document.getElementById('category-search').value = '';
        document.getElementById('category').value = '';
        const iconWrapper = document.getElementById('selected-cat-icon-wrapper');
        if (iconWrapper) {
            iconWrapper.innerHTML = '<i class="fas fa-question-circle"></i>';
        }

        document.getElementById('modal-title').textContent = 'Aggiungi';
        document.getElementById('modal').classList.remove('hidden');
    });
    document.getElementById('close-modal-btn')?.addEventListener('click', () => document.getElementById('modal').classList.add('hidden'));

    document.getElementById('transaction-form')?.addEventListener('submit', (e) => {
        e.preventDefault();

        const amt = parseFloat(document.getElementById('amount').value) || 0;
        const type = document.getElementById('selected-type').value;
        const categoryValue = document.getElementById('category').value;

        // Debug logging
        console.log('Form submit - Editing ID:', UI.editingId);
        console.log('Form data:', {
            amount: amt,
            type: type,
            category: categoryValue,
            description: document.getElementById('description').value,
            date: document.getElementById('date').value
        });

        // Fix timezone issue: use the date string directly instead of valueAsDate
        const dateInput = document.getElementById('date');
        const dateValue = dateInput.value; // Format: YYYY-MM-DD
        const dateISO = dateValue ? new Date(dateValue + 'T12:00:00').toISOString() : new Date().toISOString();

        const data = {
            type,
            amount: amt,
            description: document.getElementById('description').value,
            date: dateISO,
            accountId: document.getElementById('account-id').value,
            category: categoryValue
        };

        if (type === 'transfer') data.toAccountId = document.getElementById('to-account-id').value;

        // --- SAVINGS INTEGRATION: DETECT SAVINGS TRANSACTIONS ---
        const isToSavings = (type === 'transfer' && data.toAccountId === 'virtual_savings');
        const isFromSavings = (type === 'transfer' && data.accountId === 'virtual_savings');
        const isSavingsEdit = UI.editingId && String(UI.editingId).startsWith('sav');

        if (isToSavings || isFromSavings || isSavingsEdit) {
            if (isSavingsEdit) {
                // If it was a transfer from/to savings, update the record
                const savData = {
                    amount: data.amount,
                    note: data.description,
                    date: data.date,
                    accountId: isToSavings ? data.accountId : (isFromSavings ? data.toAccountId : data.accountId)
                };
                if (isFromSavings) savData.type = 'withdrawal';
                else savData.type = 'extra'; // Default for manual additions

                Store.editSavingsEntry(UI.editingId, savData);
            } else if (isToSavings) {
                Store.addSavings(data.amount, 'extra', data.description, data.accountId);
            } else if (isFromSavings) {
                Store.withdrawSavings(data.amount, data.description, data.toAccountId);
            }
        } else {
            // Standard Transaction Logic
            if (UI.editingId) {
                const idx = Store.data.transactions.findIndex(t => t.id == UI.editingId);
                if (idx !== -1) Store.data.transactions[idx] = { ...Store.data.transactions[idx], ...data };
            } else {
                Store.data.transactions.unshift({ id: 't_' + Date.now(), ...data });
            }
            Store.recalculateBalances();
            Store.save();
        }

        UI.updateAll();
        document.getElementById('modal').classList.add('hidden');

        // --- SAVINGS INTEGRATION: EXTRA INCOME ALLOCATION ---
        if (!UI.editingId && type === 'income' && categoryValue !== 'cat_rent' && categoryValue !== 'cat_salary') {
            const extraAllocation = Store.data.savings.settings.extraAllocation || 0.5;
            const toAllocate = amt * extraAllocation;
            if (confirm(`Hai registrato un'entrata extra di ${UI.formatCurrency(amt)}. Vuoi accantonare il 50% (${UI.formatCurrency(toAllocate)}) nel Cassetto Risparmi?`)) {
                Store.addSavings(toAllocate, 'extra', `50% di: ${data.description}`, data.accountId);
                alert(`Accantonati ${UI.formatCurrency(toAllocate)} nel fondo di sicurezza (prelevati da ${Store.data.accounts.find(a => a.id === data.accountId)?.name}).`);
            }
        }
    });

    document.querySelectorAll('.type-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active')); tab.classList.add('active');
            const type = tab.dataset.type; document.getElementById('selected-type').value = type;
            document.getElementById('category-row').classList.toggle('hidden', type === 'transfer');
            document.getElementById('to-account-row').classList.toggle('hidden', type !== 'transfer');
        });
    });

    // Populate Settings Modal on Open
    document.querySelector('[onclick*="modal-budget-settings"]')?.addEventListener('click', () => {
        tempBudget = { id: '', startDate: '', endDate: '', totalAmount: 0, categoryBudgets: {} };
        document.getElementById('budget-id').value = '';
        document.getElementById('budget-start-date').value = '';
        document.getElementById('budget-end-date').value = '';
        document.getElementById('budget-total-amount').value = 0;
        UI.renderBucketBudgetSettings({});
        UI.renderMultiBudgetSettings();
    });

    // --- ALLOGGI 2.0: LOGICA MODALE RENT ---
    // Expose UI globally for inline onclicks
    window.UI = UI;

    // Rent Modal Elements
    document.getElementById('close-modal-rent')?.addEventListener('click', () => document.getElementById('modal-pay-rent').classList.add('hidden'));
    document.getElementById('close-modal-contract')?.addEventListener('click', () => document.getElementById('modal-property').classList.add('hidden'));
    document.getElementById('close-modal-arrears')?.addEventListener('click', () => document.getElementById('modal-arrears').classList.add('hidden'));
    // --- ALLOGGI 2.0: FORM LISTENERS ---
    const contractForm = document.getElementById('contract-form');
    if (contractForm) {
        contractForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const id = document.getElementById('contract-id').value;
            const contract = {
                id: id || 'cont_' + Date.now(),
                propName: document.getElementById('contract-prop-name').value,
                tenantName: document.getElementById('contract-tenant-name').value,
                rentAmount: parseFloat(document.getElementById('contract-rent').value),
                type: document.getElementById('contract-type').value,
                startDate: document.getElementById('contract-start').value,
                endDate: document.getElementById('contract-end').value || null
            };
            Store.saveContract(contract);
            UI.updateAll();
            document.getElementById('modal-property').classList.add('hidden');
        });
    }

    const dueForm = document.getElementById('due-form');
    if (dueForm) {
        dueForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const contractId = document.getElementById('due-contract-id').value;
            const amount = parseFloat(document.getElementById('due-amount').value);
            const month = document.getElementById('due-month').value;

            if (!contractId) {
                console.error('Critical Error: No contractId found in due-form!');
                alert('Errore: ID contratto mancante. Riprova ad aprire lo storico.');
                return;
            }

            console.log('Submitting due for contract:', contractId, 'Amount:', amount, 'Month:', month);
            Store.saveDue({
                id: 'due_' + Date.now(),
                contractId: contractId,
                amount: amount,
                referenceMonth: month
            });

            console.log('Due saved successfully. Refreshing view for ID:', contractId);
            UI.manageArrears(contractId); // Ricarica lo storico
            UI.renderProperties();        // Aggiorna le card (totali ricalcolati)

            // Pulisce il form ma preserva il contractId per inserimenti multipli
            dueForm.reset();
            document.getElementById('due-contract-id').value = contractId;

            // Messaggio di conferma temporaneo (opzionale ma utile)
            console.log('UI Refreshed.');
        });
    }

    const payRentForm = document.getElementById('pay-rent-form');
    if (payRentForm) {
        payRentForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const contractId = document.getElementById('rent-property-id').value;
            const amount = parseFloat(document.getElementById('rent-amount').value);
            const datePaid = document.getElementById('rent-date-paid').value;
            const dateRef = document.getElementById('rent-date-ref').value;
            const accountId = document.getElementById('rent-account-id').value;
            const notes = document.getElementById('rent-notes').value;
            const isAccounting = document.getElementById('rent-is-accounting')?.checked;

            Store.registerRentPayment(contractId, amount, accountId, datePaid, dateRef, notes, isAccounting);

            UI.updateAll();
            document.getElementById('modal-pay-rent').classList.add('hidden');
        });
    }

    // --- SETTINGS, BACKUP & RESTORE EVENT LISTENERS ---
    document.getElementById('export-backup-btn')?.addEventListener('click', () => Store.exportBackup());

    document.getElementById('import-backup-trigger')?.addEventListener('click', () => {
        document.getElementById('import-backup-file').click();
    });

    document.getElementById('import-backup-file')?.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            Store.importBackup(e.target.files[0]);
            e.target.value = ''; // Reset for next time
        }
    });
    // --- GLOBAL EXPOSURE (BONIFICA TOOL) ---
    window.openCleanupManager = () => UI.renderCleanupManager();
    window.toggleCleanupSelect = (id) => {
        const row = document.querySelector(`.cleanup-row[data-id="${id}"]`);
        if (row) row.classList.toggle('selected');
    };
    window.bulkDeleteCleanup = () => {
        const selected = Array.from(document.querySelectorAll('.cleanup-row.selected')).map(el => el.dataset.id);
        if (selected.length === 0) return alert("Seleziona almeno un movimento da eliminare.");

        if (confirm(`Sei sicuro di voler eliminare DEFINITIVAMENTE ${selected.length} movimenti ? I saldi verranno ricalcolati.`)) {
            const deleted = Store.bulkDelete(selected);
            alert(`Bonifica completata: ${deleted} movimenti rimossi.`);
            UI.updateAll();
            UI.renderCleanupManager();
        }
    };
    window.selectAllCleanup = (check) => {
        document.querySelectorAll('.cleanup-row').forEach(row => {
            if (check) row.classList.add('selected');
            else row.classList.remove('selected');
        });
    };
    window.closeCleanup = () => {
        const el = document.getElementById('cleanup-overlay');
        if (el) el.remove();
    };

    // ===== NEW FILTERS FUNCTIONALITY =====

    // Reset filters
    const resetBtn = document.getElementById('reset-filters-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            // Clear date inputs
            const dateStart = document.getElementById('filter-date-start');
            const dateEnd = document.getElementById('filter-date-end');
            if (dateStart) dateStart.value = '';
            if (dateEnd) dateEnd.value = '';

            // Reset category filter
            const catFilter = document.getElementById('filter-category');
            if (catFilter) catFilter.value = 'all';

            // Reset account filter
            const accFilter = document.getElementById('filter-account');
            if (accFilter) accFilter.value = 'all';

            // Re-render
            UI.renderTimeline();
            UI.renderCharts();
        });
    }

    // Add event listeners for date inputs
    const dateStart = document.getElementById('filter-date-start');
    const dateEnd = document.getElementById('filter-date-end');
    if (dateStart) {
        dateStart.addEventListener('change', () => {
            UI.renderTimeline();
            UI.renderCharts();
        });
    }
    if (dateEnd) {
        dateEnd.addEventListener('change', () => {
            UI.renderTimeline();
            UI.renderCharts();
        });
    }

    // Add event listener for category filter
    const catFilter = document.getElementById('filter-category');
    if (catFilter) {
        catFilter.addEventListener('change', () => {
            UI.renderTimeline();
            UI.renderCharts();
        });
    }

    // Add event listener for account filter
    const accFilter = document.getElementById('filter-account');
    if (accFilter) {
        accFilter.addEventListener('change', () => {
            UI.renderTimeline();
            UI.renderCharts();
        });
    }

    // Show category report modal
    const showReportBtn = document.getElementById('show-category-report-btn');
    if (showReportBtn) {
        showReportBtn.addEventListener('click', () => {
            UI.renderCategoryReport();
            document.getElementById('modal-category-report').classList.remove('hidden');
        });
    }

    // Close category report modal
    const closeReportBtn = document.getElementById('close-category-report');
    if (closeReportBtn) {
        closeReportBtn.addEventListener('click', () => {
            document.getElementById('modal-category-report').classList.add('hidden');
        });
    }

    // Event listener for CSV Export
    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            UI.exportToCSV();
        });
    }

    // Event listener for Search Text (Debounced)
    const searchInput = document.getElementById('filter-search');
    let searchTimeout;
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                UI.renderTimeline();
                UI.renderCategoryReport();
                UI.renderCharts();
            }, 300);
        });
    }

    // --- SAVINGS EVENT LISTENERS ---
    document.getElementById('add-savings-btn')?.addEventListener('click', () => {
        UI.editingId = null;
        document.getElementById('transaction-form').reset();

        // Setup Transfer to Savings
        document.getElementById('selected-type').value = 'transfer';
        document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.type-tab[data-type="transfer"]')?.classList.add('active');

        document.getElementById('to-account-id').value = 'virtual_savings';
        document.getElementById('description').value = 'Risparmio';
        document.getElementById('date').value = new Date().toISOString().split('T')[0];

        document.getElementById('category-row').classList.add('hidden');
        document.getElementById('to-account-row').classList.remove('hidden');

        document.getElementById('modal-title').textContent = 'Aggiungi al Fondo';
        document.getElementById('modal').classList.remove('hidden');
    });

    document.getElementById('withdraw-savings-btn')?.addEventListener('click', () => {
        UI.editingId = null;
        document.getElementById('transaction-form').reset();

        // Setup Transfer from Savings
        document.getElementById('selected-type').value = 'transfer';
        document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.type-tab[data-type="transfer"]')?.classList.add('active');

        document.getElementById('account-id').value = 'virtual_savings';
        document.getElementById('description').value = 'Prelievo Emergenza';
        document.getElementById('date').value = new Date().toISOString().split('T')[0];

        document.getElementById('category-row').classList.add('hidden');
        document.getElementById('to-account-row').classList.remove('hidden');

        document.getElementById('modal-title').textContent = 'Preleva dal Fondo';
        document.getElementById('modal').classList.remove('hidden');
    });

    // --- SAVINGS HISTORY GLOBAL ACTIONS ---
    window.delSavTrx = (id) => {
        if (confirm("Sei sicuro di voler eliminare questo movimento dal fondo risparmi? Il saldo del conto collegato verrà ripristinato.")) {
            Store.deleteSavingsEntry(id);
        }
    };

    window.editSavTrx = (id) => {
        const entry = Store.data.savings.history.find(h => h.id === id);
        if (!entry) return;

        UI.editingId = id;
        document.getElementById('transaction-form').reset();

        document.getElementById('amount').value = entry.amount;
        document.getElementById('description').value = entry.note || "";
        document.getElementById('date').value = entry.date.split('T')[0];

        // Set as transfer
        document.getElementById('selected-type').value = 'transfer';
        document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.type-tab[data-type="transfer"]')?.classList.add('active');
        document.getElementById('category-row').classList.add('hidden');
        document.getElementById('to-account-row').classList.remove('hidden');

        if (entry.type === 'withdrawal') {
            document.getElementById('account-id').value = 'virtual_savings';
            document.getElementById('to-account-id').value = entry.accountId || '';
        } else {
            document.getElementById('account-id').value = entry.accountId || '';
            document.getElementById('to-account-id').value = 'virtual_savings';
        }

        document.getElementById('modal-title').textContent = 'Modifica Risparmio';
        document.getElementById('modal').classList.remove('hidden');
    };

    // --- INITIALIZE APP ---
    Store.init();

});
