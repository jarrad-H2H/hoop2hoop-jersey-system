// FILE: src/HealthCheck.tsx
import React, { useEffect } from 'react';
import { supabase } from './services/supabase';

const HealthCheck: React.FC = () => {
  useEffect(() => {
    const checkConnection = async () => {
      console.log('HealthCheck: Initiating connection test...');
      
      try {
        const { data, error } = await supabase.from('clubs').select('*');
        
        console.log('HealthCheck: Supabase Data:', data);
        console.log('HealthCheck: Supabase Error:', error);
        
        if (error) {
          console.error('HealthCheck: Connection failed with error message:', error.message);
        } else {
          console.log('HealthCheck: Connection successful. Row count:', data?.length);
        }
      } catch (err) {
        console.error('HealthCheck: Unexpected exception:', err);
      }
    };

    checkConnection();
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Health Check Loaded</h1>
      <p>Please open your browser console (F12 or Ctrl+Shift+I) to view the connection results.</p>
    </div>
  );
};

export default HealthCheck;