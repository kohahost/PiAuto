const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const fs = require('fs');
require("dotenv").config();

const PI_API_SERVER = 'https://api.mainnet.minepi.com';
const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(PI_API_SERVER, { allowHttp: PI_API_SERVER.startsWith('http://') });

// === FUNGSI UTILITAS ===

function loadMnemonics(filePath) {
    try {
        if (!fs.existsSync(filePath)) throw new Error(`File wallet tidak ditemukan: ${filePath}`);
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.length) throw new Error(`File wallet ${filePath} kosong!`);
        return lines;
    } catch (e) {
        console.error(`❌ Gagal membaca file ${filePath}:`, e.message);
        process.exit(1);
    }
}

async function getWalletFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) return null;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

// === FUNGSI INTI UNTUK MENYIAPKAN & MENGIRIM TRANSAKSI ===

async function prepareAndSendBatch(batch, feePayerKeypair, config) {
    console.log(`\n--- Menyiapkan Batch berisi ${batch.length} transaksi... ---`);
    
    // Muat akun pembayar fee sekali saja untuk seluruh batch
    const feePayerAccount = await server.loadAccount(feePayerKeypair.publicKey());
    const baseFee = await server.fetchBaseFee();
    const feeForBump = (baseFee * 2 * config.feeMultiplier).toString();

    const transactionPromises = batch.map(async (sourceMnemonic, index) => {
        const sourceKeypair = await getWalletFromMnemonic(sourceMnemonic);
        if (!sourceKeypair) {
            console.log(`[${index+1}] Mnemonic tidak valid, dilewati.`);
            return null;
        }

        try {
            const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
            
            let amountToSend;
            if (config.amount.toUpperCase() === 'MAX') {
                const balance = parseFloat(sourceAccount.balances.find(b => b.asset_type === 'native').balance);
                amountToSend = balance - 1.0;
                if (amountToSend <= 0) {
                    // console.log(`[${index+1}] Saldo ${sourceKeypair.publicKey().substring(0, 8)} tidak cukup, dilewati.`);
                    return null;
                }
            } else {
                amountToSend = parseFloat(config.amount);
            }

            const innerTransaction = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: "0",
                networkPassphrase: PI_NETWORK_PASSPHRASE,
            })
            .addOperation(StellarSdk.Operation.payment({
                destination: config.recipient,
                asset: StellarSdk.Asset.native(),
                amount: amountToSend.toFixed(7),
            }))
            .setTimeout(config.timeout)
            .build();

            innerTransaction.sign(sourceKeypair);

            const feeBumpTransaction = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
                feePayerKeypair.publicKey(),
                feeForBump,
                innerTransaction,
                PI_NETWORK_PASSPHRASE
            );

            feeBumpTransaction.sign(feePayerKeypair);

            return { tx: feeBumpTransaction, source: sourceKeypair.publicKey(), amount: amountToSend.toFixed(7) };

        } catch (error) {
            if(error.response && error.response.status === 404){
                // console.log(`[${index+1}] Akun ${sourceKeypair.publicKey().substring(0, 8)} belum aktif, dilewati.`);
            } else {
                console.error(`[${index+1}] Error saat menyiapkan TX untuk ${sourceKeypair.publicKey().substring(0, 8)}: ${error.message}`);
            }
            return null;
        }
    });

    const preparedTransactions = (await Promise.all(transactionPromises)).filter(tx => tx !== null);
    console.log(`✅ ${preparedTransactions.length} dari ${batch.length} transaksi berhasil disiapkan.`);
    
    if (preparedTransactions.length === 0) return;

    console.log(`\n🔥 Mengirim ${preparedTransactions.length} transaksi ke jaringan secepat mungkin...`);
    const submissionPromises = preparedTransactions.map(pTx => 
        server.submitTransaction(pTx.tx)
            .then(result => {
                console.log(`[OK] ${pTx.source.substring(0, 8)} -> ${pTx.amount} π | Hash: ${result.hash.substring(0,10)}...`);
                return { status: 'success', source: pTx.source };
            })
            .catch(error => {
                const result_codes = error.response?.data?.extras?.result_codes;
                console.error(`[FAIL] ${pTx.source.substring(0, 8)} | Alasan: ${result_codes ? JSON.stringify(result_codes) : error.message}`);
                return { status: 'failed', source: pTx.source };
            })
    );

    await Promise.all(submissionPromises);
}


// === FUNGSI UTAMA BOT ===
(async () => {
    console.log("🚀 Memulai Bot Pi Transfer (Mode SPAM Fee-Bump)...");

    // Muat konfigurasi dari .env
    const config = {
        recipient: process.env.RECEIVER_MUXED_ADDRESS,
        amount: process.env.AMOUNT_TO_SEND,
        feeMultiplier: parseInt(process.env.FEE_MULTIPLIER, 10),
        timeout: parseInt(process.env.TRANSACTION_TIMEOUT, 10),
        batchSize: parseInt(process.env.PARALLEL_BATCH_SIZE, 10)
    };

    if (!config.recipient || !config.batchSize || !config.feeMultiplier) {
        console.error("❌ KESALAHAN: Pastikan RECEIVER_MUXED_ADDRESS, PARALLEL_BATCH_SIZE, dan FEE_MULTIPLIER diisi di file .env!");
        return;
    }

    // Muat daftar wallet
    const sourceMnemonics = loadMnemonics('sumber.txt');
    const feePayerMnemonics = loadMnemonics('pembayar_fee.txt');

    if (feePayerMnemonics.length > 1) {
        console.warn("⚠️ PERINGATAN: Ditemukan lebih dari 1 dompet di pembayar_fee.txt. Hanya yang pertama yang akan digunakan dalam mode spam.");
    }

    const feePayerKeypair = await getWalletFromMnemonic(feePayerMnemonics[0]);
    if (!feePayerKeypair) {
        console.error("❌ KESALAHAN: Mnemonic di pembayar_fee.txt tidak valid!");
        return;
    }

    console.log(`- Dompet Pembayar Fee: ${feePayerKeypair.publicKey()}`);
    console.log(`- Total Dompet Sumber: ${sourceMnemonics.length}`);
    console.log(`- Ukuran Batch: ${config.batchSize}`);

    // Proses dalam batch
    for (let i = 0; i < sourceMnemonics.length; i += config.batchSize) {
        const batch = sourceMnemonics.slice(i, i + config.batchSize);
        await prepareAndSendBatch(batch, feePayerKeypair, config);
    }

    console.log("\n\n✅ Semua batch telah selesai diproses.");
})();
