require('dotenv').config({ path: '../.env' });
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY;

if (!SUPABASE_URL || !SUPABASE_API_KEY) {
  console.error('❌ Missing Supabase environment variables. Please check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_API_KEY);

async function clearFirst200() {
  try {
    console.log('🗑️ Deleting first 200 rows from bridged_events...');
    
    // First, get the first 200 rows to see what we're deleting
    const { data: rowsToDelete, error: selectError } = await supabase
      .from('bridged_events')
      .select('tx_id, address, status, block_number')
      .order('block_number', { ascending: true })
      .limit(200);
    
    if (selectError) {
      console.error('❌ Error selecting rows:', selectError);
      return;
    }
    
    console.log(`📊 Found ${rowsToDelete.length} rows to delete`);
    
    if (rowsToDelete.length === 0) {
      console.log('ℹ️ No rows found to delete');
      return;
    }
    
    // Show first few rows that will be deleted
    console.log('📋 First 5 rows to be deleted:');
    rowsToDelete.slice(0, 5).forEach((row, index) => {
      console.log(`${index + 1}. TX: ${row.tx_id}, User: ${row.address}, Status: ${row.status}, Block: ${row.block_number}`);
    });
    
    // Get the tx_ids to delete
    const txIdsToDelete = rowsToDelete.map(row => row.tx_id);
    
    // Delete the rows
    const { error: deleteError } = await supabase
      .from('bridged_events')
      .delete()
      .in('tx_id', txIdsToDelete);
    
    if (deleteError) {
      console.error('❌ Error deleting rows:', deleteError);
      return;
    }
    
    console.log(`✅ Successfully deleted ${txIdsToDelete.length} rows from bridged_events`);
    
  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }
}

clearFirst200();
