import React from 'react'; 
import SystemStatus from './SystemStatus';
import TaskQueueStats from './TaskQueueStats';
import TaskList from './TaskList';

const Dashboard: React.FC = () => {
  return (
    <div>
      <h2 className="text-2xl font-semibold text-white mb-6">System Overview</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <SystemStatus />
        <TaskQueueStats />
      </div>
      
      <div>
        <h3 className="text-xl font-semibold text-white mb-4">Recent Tasks</h3>
        <TaskList
          limit={5}
          showViewAll={true}
          hideFilters={true}
        />
      </div>
    </div>
  );
};

export default Dashboard;