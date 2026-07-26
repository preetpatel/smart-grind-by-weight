#pragma once
#include "blocking_overlay.h"
#include "../../hardware/hardware_manager.h"
#include "../../controllers/grind_controller.h"

class UIOperations {
public:
    // Unified tare operation for any screen. The previous zero is kept when the tare fails, so
    // completion is skipped and on_failure runs instead - callers must not advance on failure.
    static void execute_tare(HardwareManager* hw_manager,
                             OperationCallback completion = nullptr,
                             OperationCallback on_failure = nullptr);

    // Unified calibration operation. Keeps the previous factor on failure, see execute_tare.
    static void execute_calibration(HardwareManager* hw_manager, float cal_weight,
                                    OperationCallback completion = nullptr,
                                    OperationCallback on_failure = nullptr);
    
    // Grind controller tare (uses grind controller's method)
    static void execute_grind_tare(GrindController* grind_controller, OperationCallback completion = nullptr);
    
    // Custom operation with custom message
    static void execute_custom_operation(const char* message, 
                                        OperationCallback operation,
                                        OperationCallback completion = nullptr);
};
