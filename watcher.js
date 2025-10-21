require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SIGNER_KEY = process.env.SIGNER_KEY;
const L2_ADDRESS = process.env.NEXT_PUBLIC_SUPERBRIDGE_L2_ADDRESS;
const L1_ADDRESS = process.env.NEXT_PUBLIC_SUPERBRIDGE_L1_ADDRESS;
const RPC_URL = "https://rpc-pepu-v2-mainnet-0.t.conduit.xyz";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY;

// The authorized signer address (from your contract)
const AUTHORIZED_SIGNER = "0x9e09fd3f7Bf43E68A1C813e02d0f5da519AaEbEd";

if (!PRIVATE_KEY || !SIGNER_KEY || !L2_ADDRESS || !L1_ADDRESS || !SUPABASE_URL || !SUPABASE_API_KEY || !process.env.ETHEREUM_RPC_URL) {
  console.error('❌ Missing environment variables. Please check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_API_KEY);

// Minimal ABIs for event, payout, and getTransfer
const L2_ABI = [
  "event BridgeInitiated(address indexed user, uint256 originalAmount, uint256 bridgedAmount, bytes32 transferId, uint256 timestamp)",
  "event Refunded(bytes32 indexed transferId, address user, uint256 amount)",
  "function getTransfer(bytes32 transferId) external view returns (tuple(address user, uint256 originalAmount, uint256 bridgedAmount, uint256 timestamp, uint8 status))"
];
const L1_ABI = [
  "function payout(bytes32 transferId, address user, uint256 bridgedAmount) external"
];

const L2_COMPLETE_ABI = [
  "function complete(bytes32 transferId, bytes[] calldata signatures, address[] calldata signers) external",
  "function getTransfer(bytes32 transferId) external view returns (tuple(address user, uint256 originalAmount, uint256 bridgedAmount, uint256 timestamp, uint8 status))"
];

// Status enum mapping (from contract)
const STATUS = {
  0: 'Pending',
  1: 'Completed',
  2: 'Refunded',
};

const POLL_INTERVAL = 5000; // 5 seconds
let lastCheckedBlock = 0;

async function getStartingBlock(provider) {
  try {
    const currentBlock = await provider.getBlockNumber();
    const startingBlock = Math.max(0, currentBlock - 200);
    console.log(`📊 Starting from block ${startingBlock} (last 200 blocks)`);
    return startingBlock;
  } catch (err) {
    console.error('❌ Error getting starting block:', err);
    return null;
  }
}

async function signMessage(transferId, user, bridgedAmount, contractAddress) {
  try {
    // Convert transferId to bytes32 if it's a hex string
    const transferIdBytes = transferId.startsWith('0x') ? transferId : '0x' + transferId;
    
    const rawHash = ethers.keccak256(ethers.solidityPacked(
      ['bytes32', 'address', 'uint256', 'address'],
      [transferIdBytes, user, bridgedAmount, contractAddress]
    ));
    
    const signer = new ethers.Wallet(SIGNER_KEY);
    const signature = await signer.signMessage(ethers.getBytes(rawHash));
    
    console.log('✅ Message signed successfully');
    console.log('Transfer ID:', transferId);
    console.log('User:', user);
    console.log('Bridged Amount:', bridgedAmount.toString());
    console.log('Signature:', signature);
    
    return signature;
  } catch (err) {
    console.error('❌ Error signing message:', err);
    throw err;
  }
}

async function callCompleteOnL2(transferId, user, bridgedAmount, signature) {
  try {
    const l2Provider = new ethers.JsonRpcProvider(RPC_URL);
    const l2Wallet = new ethers.Wallet(SIGNER_KEY, l2Provider);
    const l2Contract = new ethers.Contract(L2_ADDRESS, L2_COMPLETE_ABI, l2Wallet);
    
    console.log('🔑 Executor wallet address:', l2Wallet.address);
    console.log('🔑 Expected authorized signer:', AUTHORIZED_SIGNER);
    
    console.log('⛓️ Calling complete on L2...');
    console.log('Transfer ID:', transferId);
    console.log('User:', user);
    console.log('Bridged Amount:', bridgedAmount.toString());
    
    const tx = await l2Contract.complete(
      transferId,
      [signature],
      [AUTHORIZED_SIGNER]
    );
    
    console.log('⏳ Waiting for L2 transaction confirmation...');
    await tx.wait();
    
    console.log('✅ L2 complete transaction confirmed!');
    console.log('Transaction hash:', tx.hash);
    
    return tx.hash;
  } catch (err) {
    console.error('❌ Error calling complete on L2:', err);
    throw err;
  }
}

async function updateSupabaseComplete(transferId, l1BlockNumber, l2TxHash, signature) {
  try {
    const updateData = {
      status: 'Completed',
      l1_block_number: l1BlockNumber,
      signature1: signature
    };
    
    const { error } = await supabase
      .from('bridged_events')
      .update(updateData)
      .eq('tx_id', transferId);
    
    if (error) {
      console.error('❌ Error updating Supabase completion data:', error);
      throw error;
    }
    
    console.log('✅ Supabase updated with completion data:');
    console.log('  - Status: Completed');
    console.log('  - L1 Block Number:', l1BlockNumber);
    console.log('  - Signature1:', signature);
  } catch (err) {
    console.error('❌ Error updating Supabase completion data:', err);
    throw err;
  }
}

async function processPayoutCompletion(transferId, user, bridgedAmount, payoutBlockNumber) {
  try {
    console.log('🔍 Processing payout completion for transfer:', transferId);
    console.log('🔍 User:', user);
    console.log('🔍 Bridged Amount:', bridgedAmount.toString());
    console.log('🔍 Payout Block Number:', payoutBlockNumber);
    
    // Get L2 transfer data for signature
    console.log('🔍 Getting L2 transfer data...');
    const l2Provider = new ethers.JsonRpcProvider(RPC_URL);
    const l2Contract = new ethers.Contract(L2_ADDRESS, L2_COMPLETE_ABI, l2Provider);
    const transfer = await l2Contract.getTransfer(transferId);
    
    console.log('L2 Transfer data:', {
      user: transfer.user,
      bridgedAmount: transfer.bridgedAmount.toString(),
      status: transfer.status.toString()
    });
    
    // Create signature
    console.log('🔍 Creating signature...');
    const signature = await signMessage(transferId, transfer.user, transfer.bridgedAmount, L2_ADDRESS);
    
    // Double-check status before calling complete
    console.log('🔍 Double-checking status...');
    const doubleCheck = await l2Contract.getTransfer(transferId);
    console.log('Double-check status:', doubleCheck.status.toString());
    
    // Status enum: Pending=0, Completed=1, Refunded=2
    if (doubleCheck.status === 1n || doubleCheck.status === 1) {
      console.log('❌ Transfer already completed (status=1), skipping...');
      return;
    } else if (doubleCheck.status === 2n || doubleCheck.status === 2) {
      console.log('❌ Transfer was refunded (status=2), skipping...');
      return;
    } else if (doubleCheck.status !== 0n && doubleCheck.status !== 0) {
      console.log('❌ Transfer has unknown status, skipping...');
      return;
    }
    
    // Call complete on L2
    console.log('🔍 Calling complete on L2...');
    const l2TxHash = await callCompleteOnL2(transferId, user, bridgedAmount, signature);
    
    // Update Supabase with completion data
    console.log('🔍 Updating Supabase...');
    await updateSupabaseComplete(transferId, payoutBlockNumber, l2TxHash, signature);
    
    console.log('🎉 Complete flow finished successfully!');
    console.log('L1 Payout Block:', payoutBlockNumber);
    console.log('L2 Complete Tx:', l2TxHash);
    console.log('Supabase Status: completed');
    
  } catch (err) {
    console.error('❌ Error processing payout completion:', err);
    console.error('❌ Error details:', err.message);
    console.error('❌ Error stack:', err.stack);
  }
}

async function main() {
  const l2Provider = new ethers.JsonRpcProvider(RPC_URL);
  const l1Provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
  const l1Wallet = new ethers.Wallet(PRIVATE_KEY, l1Provider);

  const l2 = new ethers.Contract(L2_ADDRESS, L2_ABI, l2Provider);
  const l1 = new ethers.Contract(L1_ADDRESS, L1_ABI, l1Wallet);

  // Get starting block
  const startingBlock = await getStartingBlock(l2Provider);
  
  if (startingBlock === null) {
    console.error('❌ Failed to determine starting block. Exiting.');
    process.exit(1);
  }
  
  lastCheckedBlock = startingBlock;

  console.log('⏳ Unified Watcher+Executor started!');
  console.log('L2 Contract:', L2_ADDRESS);
  console.log('L1 Contract:', L1_ADDRESS);
  console.log('Authorized Signer:', AUTHORIZED_SIGNER);

  setInterval(async () => {
    try {
      const currentBlock = await l2Provider.getBlockNumber();
      if (currentBlock <= lastCheckedBlock) return;

      // Query for BridgeInitiated events from last checked block
      const bridgeEvents = [];
      let fromBlock = lastCheckedBlock + 1;
      
      while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + 499, currentBlock);
        console.log(`🔍 Querying BridgeInitiated blocks ${fromBlock} to ${toBlock}...`);
        
        const bridgeFilter = l2.filters.BridgeInitiated();
        const chunkEvents = await l2.queryFilter(bridgeFilter, fromBlock, toBlock);
        bridgeEvents.push(...chunkEvents);
        
        fromBlock = toBlock + 1;
      }

      // Query for Refunded events from last checked block
      const refundEvents = [];
      fromBlock = lastCheckedBlock + 1;
      
      while (fromBlock <= currentBlock) {
        const toBlock = Math.min(fromBlock + 499, currentBlock);
        console.log(`🔍 Querying Refunded blocks ${fromBlock} to ${toBlock}...`);
        
        const refundFilter = l2.filters.Refunded();
        const chunkEvents = await l2.queryFilter(refundFilter, fromBlock, toBlock);
        refundEvents.push(...chunkEvents);
        
        fromBlock = toBlock + 1;
      }

      // Process BridgeInitiated events
      for (const event of bridgeEvents) {
        const { user, originalAmount, bridgedAmount, transferId, timestamp } = event.args;
        const blockNumber = event.blockNumber;
        
        console.log(`\n🔔 BridgeInitiated detected!`);
        console.log('User:', user);
        console.log('Original Amount:', originalAmount.toString());
        console.log('Bridged Amount:', bridgedAmount.toString());
        console.log('Transfer ID:', transferId);
        console.log('Block Number:', blockNumber);
        console.log('Timestamp:', timestamp.toString());

        // Check if already exists in Supabase
        const { data: existing, error: selectError } = await supabase
          .from('bridged_events')
          .select('tx_id')
          .eq('tx_id', transferId);
        if (selectError) {
          console.error('❌ Supabase select error:', selectError);
          continue;
        }
        if (existing && existing.length > 0) {
          console.log('ℹ️ Already in Supabase:', transferId);
          continue;
        }

        // Query the status from L2 BEFORE storing
        const transfer = await l2.getTransfer(transferId);
        const statusNum = transfer.status;
        const statusStr = STATUS[statusNum] || `Unknown (${statusNum})`;
        console.log('Current status:', statusStr);
        console.log('Status number:', statusNum);

        // Only store and process if status is 0 (Pending)
        if (statusNum === 0n || statusNum === 0) {
          // Store to Supabase only for Pending transactions
          const { error: insertError } = await supabase
            .from('bridged_events')
            .insert([
              {
                tx_id: transferId,
                address: user,
                bridged_amount: bridgedAmount.toString(),
                status: 'pending',
                block_number: blockNumber,
                timestamp: timestamp.toString(),
              },
            ]);
          if (insertError) {
            console.error('❌ Supabase insert error:', insertError);
          } else {
            console.log('✅ Added to Supabase (Pending):', transferId);
          }

          // Call payout for Pending transactions with retry logic
          let retryCount = 0;
          const maxRetries = 3;
          let payoutSuccess = false;
          let payoutTx = null;
          
          while (retryCount < maxRetries && !payoutSuccess) {
            try {
              console.log(`⛓️  Attempting payout (attempt ${retryCount + 1}/${maxRetries})...`);
              payoutTx = await l1.payout(transferId, user, bridgedAmount);
              console.log('⛓️  Sent payout tx:', payoutTx.hash);
              const receipt = await payoutTx.wait();
              console.log('✅ Payout confirmed!');
              payoutSuccess = true;
              payoutTx.blockNumber = receipt.blockNumber; // Get block number from receipt
            } catch (err) {
              retryCount++;
              console.error(`❌ Error processing payout (attempt ${retryCount}/${maxRetries}):`, err.message);
              
              if (retryCount < maxRetries) {
                // Wait before retry (exponential backoff)
                const waitTime = Math.pow(2, retryCount) * 1000; // 2s, 4s, 8s
                console.log(`⏳ Waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
              } else {
                console.error('❌ All payout attempts failed for transfer:', transferId);
              }
            }
          }
          
          // Complete on L2 if payout succeeded
          if (payoutSuccess && payoutTx) {
            console.log('🔍 Starting executor logic for completed payout...');
            console.log('Payout TX:', payoutTx.hash);
            console.log('Payout Block:', payoutTx.blockNumber);
            try {
              await processPayoutCompletion(transferId, user, bridgedAmount, payoutTx.blockNumber);
            } catch (err) {
              console.error('❌ Error in processPayoutCompletion:', err);
            }
          }
        } else {
          console.log('⏩ Skipping: status is not Pending (0). Status:', statusStr);
        }
        
        // Add delay between events to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }

      // Process Refunded events
      for (const event of refundEvents) {
        const { transferId, user, amount } = event.args;
        const blockNumber = event.blockNumber;
        
        console.log(`\n💰 Refunded detected!`);
        console.log('Transfer ID:', transferId);
        console.log('User:', user);
        console.log('Amount:', amount.toString());
        console.log('Block Number:', blockNumber);

        // Update Supabase status to 'refunded'
        const { error: updateError } = await supabase
          .from('bridged_events')
          .update({ 
            status: 'refunded'
          })
          .eq('tx_id', transferId);

        if (updateError) {
          console.error('❌ Supabase update error for refund:', updateError);
        } else {
          console.log('✅ Updated Supabase status to refunded:', transferId);
        }
      }
      
      lastCheckedBlock = currentBlock;
    } catch (err) {
      console.error('❌ Error polling for events:', err);
    }
  }, POLL_INTERVAL);
}

main().catch(console.error); 