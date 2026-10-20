-- =====================================================================
--  Smart Vehicle Emission & Noise Monitoring - full database setup
--  MySQL 8.0+. WARNING: drops and recreates smart_emission_db.
--  Use this only for a fresh install. If your database already exists,
--  run 02_upgrade_existing.sql instead.
-- =====================================================================
DROP DATABASE IF EXISTS smart_emission_db;
CREATE DATABASE smart_emission_db CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE smart_emission_db;
CREATE TABLE Vehicles (
    vehicle_id INT NOT NULL AUTO_INCREMENT, license_plate VARCHAR(15) NOT NULL,
    owner_name VARCHAR(100) NOT NULL, owner_email VARCHAR(120) NOT NULL,
    engine_type ENUM('Petrol','Diesel','CNG') NOT NULL, registration_date DATE NOT NULL,
    PRIMARY KEY (vehicle_id), UNIQUE KEY uq_vehicle_plate (license_plate)) ENGINE=InnoDB;
CREATE TABLE IoT_Sensors (
    sensor_id INT NOT NULL AUTO_INCREMENT, vehicle_id INT NOT NULL, mac_address CHAR(17) NOT NULL,
    installation_date DATE NOT NULL, sensor_status ENUM('Active','Faulty') NOT NULL DEFAULT 'Active',
    PRIMARY KEY (sensor_id), UNIQUE KEY uq_sensor_mac (mac_address),
    CONSTRAINT fk_sensor_vehicle FOREIGN KEY (vehicle_id) REFERENCES Vehicles (vehicle_id) ON DELETE CASCADE ON UPDATE CASCADE) ENGINE=InnoDB;
CREATE TABLE Zones (
    zone_id INT NOT NULL AUTO_INCREMENT, zone_name VARCHAR(80) NOT NULL,
    zone_type ENUM('Silence','Residential','Commercial','Industrial') NOT NULL,
    min_lat DECIMAL(9,6) NOT NULL, max_lat DECIMAL(9,6) NOT NULL, min_lng DECIMAL(9,6) NOT NULL, max_lng DECIMAL(9,6) NOT NULL,
    max_noise_limit DECIMAL(5,1) NOT NULL, PRIMARY KEY (zone_id),
    CONSTRAINT chk_zone_box CHECK (min_lat < max_lat AND min_lng < max_lng)) ENGINE=InnoDB;
CREATE TABLE Compliance_Thresholds (
    threshold_id INT NOT NULL AUTO_INCREMENT, engine_type ENUM('Petrol','Diesel','CNG') NOT NULL,
    max_co_limit DECIMAL(7,2) NOT NULL, max_no2_limit DECIMAL(7,2) NOT NULL, max_noise_limit DECIMAL(5,1) NOT NULL,
    emission_fine DECIMAL(8,2) NOT NULL DEFAULT 500.00, noise_fine DECIMAL(8,2) NOT NULL DEFAULT 300.00,
    PRIMARY KEY (threshold_id), UNIQUE KEY uq_threshold_engine (engine_type)) ENGINE=InnoDB;
CREATE TABLE Telemetry_Logs (
    log_id BIGINT NOT NULL AUTO_INCREMENT, sensor_id INT NOT NULL,
    co_level DECIMAL(7,2) NOT NULL, no2_level DECIMAL(7,2) NOT NULL, noise_level DECIMAL(5,1) NOT NULL,
    latitude DECIMAL(9,6) NOT NULL, longitude DECIMAL(9,6) NOT NULL,
    recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (log_id),
    CONSTRAINT fk_log_sensor FOREIGN KEY (sensor_id) REFERENCES IoT_Sensors (sensor_id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT chk_log_values CHECK (co_level >= 0 AND no2_level >= 0 AND noise_level BETWEEN 0 AND 200
        AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)) ENGINE=InnoDB;
CREATE TABLE Violations_Log (
    violation_id BIGINT NOT NULL AUTO_INCREMENT, vehicle_id INT NOT NULL, log_id BIGINT NOT NULL, zone_id INT NULL,
    violation_type ENUM('Emission','Noise','Both') NOT NULL,
    co_excess DECIMAL(7,2) NOT NULL DEFAULT 0, no2_excess DECIMAL(7,2) NOT NULL DEFAULT 0, noise_excess DECIMAL(5,1) NOT NULL DEFAULT 0,
    fine_amount DECIMAL(8,2) NOT NULL, status ENUM('Pending','Paid') NOT NULL DEFAULT 'Pending',
    occurred_at DATETIME NOT NULL, paid_at DATETIME NULL, PRIMARY KEY (violation_id),
    UNIQUE KEY uq_violation_log (log_id), KEY idx_violation_time (occurred_at), KEY idx_violation_status (status),
    CONSTRAINT fk_violation_vehicle FOREIGN KEY (vehicle_id) REFERENCES Vehicles (vehicle_id) ON DELETE CASCADE,
    CONSTRAINT fk_violation_log FOREIGN KEY (log_id) REFERENCES Telemetry_Logs (log_id) ON DELETE CASCADE,
    CONSTRAINT fk_violation_zone FOREIGN KEY (zone_id) REFERENCES Zones (zone_id) ON DELETE SET NULL) ENGINE=InnoDB;
INSERT INTO Compliance_Thresholds (engine_type, max_co_limit, max_no2_limit, max_noise_limit, emission_fine, noise_fine) VALUES
 ('Petrol',250.00,50.00,80.0,500.00,300.00),('Diesel',150.00,120.00,80.0,750.00,300.00),('CNG',100.00,30.00,80.0,400.00,300.00);
INSERT INTO Zones (zone_name, zone_type, min_lat, max_lat, min_lng, max_lng, max_noise_limit) VALUES
 ('Central Hospital Silence Zone','Silence',12.955000,12.960000,77.595000,77.600000,68.0),
 ('Lakeview Residential','Residential',12.920000,12.935000,77.575000,77.595000,72.0),
 ('Downtown Commercial','Commercial',12.970000,12.978000,77.600000,77.615000,80.0),
 ('North Industrial Estate','Industrial',13.020000,13.040000,77.500000,77.530000,85.0);
DELIMITER $$
CREATE TRIGGER trg_check_environmental_compliance AFTER INSERT ON Telemetry_Logs FOR EACH ROW
trg_body: BEGIN
    DECLARE v_vehicle_id INT; DECLARE v_engine_type VARCHAR(10); DECLARE v_status VARCHAR(10);
    DECLARE v_zone_id INT; DECLARE v_zone_noise DECIMAL(5,1);
    DECLARE v_max_co DECIMAL(7,2); DECLARE v_max_no2 DECIMAL(7,2); DECLARE v_max_noise DECIMAL(5,1);
    DECLARE v_emission_fine DECIMAL(8,2); DECLARE v_noise_fine DECIMAL(8,2);
    DECLARE v_co_ex DECIMAL(7,2) DEFAULT 0; DECLARE v_no2_ex DECIMAL(7,2) DEFAULT 0; DECLARE v_noise_ex DECIMAL(5,1) DEFAULT 0;
    DECLARE v_emission_hit BOOLEAN DEFAULT FALSE; DECLARE v_noise_hit BOOLEAN DEFAULT FALSE;
    DECLARE v_not_found BOOLEAN DEFAULT FALSE;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_not_found = TRUE;
    SELECT v.vehicle_id, v.engine_type, s.sensor_status INTO v_vehicle_id, v_engine_type, v_status
      FROM IoT_Sensors s JOIN Vehicles v ON s.vehicle_id = v.vehicle_id WHERE s.sensor_id = NEW.sensor_id;
    IF v_vehicle_id IS NULL OR v_status <> 'Active' THEN LEAVE trg_body; END IF;
    SELECT max_co_limit, max_no2_limit, max_noise_limit, emission_fine, noise_fine
      INTO v_max_co, v_max_no2, v_max_noise, v_emission_fine, v_noise_fine
      FROM Compliance_Thresholds WHERE engine_type = v_engine_type LIMIT 1;
    IF v_max_co IS NULL THEN LEAVE trg_body; END IF;
    SELECT zone_id, max_noise_limit INTO v_zone_id, v_zone_noise FROM Zones
     WHERE NEW.latitude BETWEEN min_lat AND max_lat AND NEW.longitude BETWEEN min_lng AND max_lng
     ORDER BY max_noise_limit ASC LIMIT 1;
    SET v_max_noise = COALESCE(v_zone_noise, v_max_noise);
    SET v_co_ex = GREATEST(NEW.co_level - v_max_co, 0);
    SET v_no2_ex = GREATEST(NEW.no2_level - v_max_no2, 0);
    SET v_noise_ex = GREATEST(NEW.noise_level - v_max_noise, 0);
    SET v_emission_hit = (v_co_ex > 0 OR v_no2_ex > 0);
    SET v_noise_hit = (v_noise_ex > 0);
    IF v_emission_hit OR v_noise_hit THEN
        INSERT INTO Violations_Log (vehicle_id, log_id, zone_id, violation_type, co_excess, no2_excess, noise_excess, fine_amount, status, occurred_at)
        VALUES (v_vehicle_id, NEW.log_id, v_zone_id,
             CASE WHEN v_emission_hit AND v_noise_hit THEN 'Both' WHEN v_emission_hit THEN 'Emission' ELSE 'Noise' END,
             v_co_ex, v_no2_ex, v_noise_ex,
             IF(v_emission_hit, v_emission_fine, 0) + IF(v_noise_hit, v_noise_fine, 0), 'Pending', NEW.recorded_at);
    END IF;
END$$
CREATE PROCEDURE GetZoneHotspots(IN p_start DATETIME, IN p_end DATETIME, IN p_limit INT)
BEGIN
    SELECT ROUND(t.latitude,3) AS grid_lat, ROUND(t.longitude,3) AS grid_lng,
        COALESCE(MAX(z.zone_name),'Unzoned') AS zone_name, COUNT(*) AS total_violations,
        SUM(vl.violation_type IN ('Emission','Both')) AS emission_count, SUM(vl.violation_type IN ('Noise','Both')) AS noise_count,
        COUNT(DISTINCT vl.vehicle_id) AS distinct_vehicles, ROUND(AVG(t.noise_level),1) AS avg_noise_db,
        ROUND(AVG(t.co_level),2) AS avg_co_ppm, SUM(vl.fine_amount) AS total_fines
    FROM Violations_Log vl JOIN Telemetry_Logs t ON vl.log_id = t.log_id LEFT JOIN Zones z ON vl.zone_id = z.zone_id
    WHERE vl.occurred_at BETWEEN p_start AND p_end GROUP BY grid_lat, grid_lng ORDER BY total_violations DESC LIMIT p_limit;
END$$
CREATE PROCEDURE GetRepeatOffenders(IN p_days INT, IN p_min_violations INT)
BEGIN
    SELECT v.vehicle_id, v.license_plate, v.owner_name, v.owner_email, v.engine_type, COUNT(*) AS violations,
        SUM(vl.status='Pending') AS unpaid, SUM(CASE WHEN vl.status='Pending' THEN vl.fine_amount ELSE 0 END) AS pending_amount,
        MAX(vl.occurred_at) AS last_violation
    FROM Violations_Log vl JOIN Vehicles v ON v.vehicle_id = vl.vehicle_id
    WHERE vl.occurred_at >= NOW() - INTERVAL p_days DAY
    GROUP BY v.vehicle_id, v.license_plate, v.owner_name, v.owner_email, v.engine_type
    HAVING COUNT(*) >= p_min_violations ORDER BY violations DESC, pending_amount DESC;
END$$
CREATE PROCEDURE PayFine(IN p_violation_id BIGINT)
BEGIN
    UPDATE Violations_Log SET status='Paid', paid_at=NOW() WHERE violation_id=p_violation_id AND status='Pending';
    IF ROW_COUNT() = 0 THEN
        IF EXISTS (SELECT 1 FROM Violations_Log WHERE violation_id = p_violation_id) THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fine already paid';
        ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Violation not found'; END IF;
    END IF;
END$$
DELIMITER ;
CREATE VIEW vw_vehicle_compliance AS
SELECT v.vehicle_id, v.license_plate, v.owner_name, v.engine_type, COUNT(vl.violation_id) AS total_violations,
    COALESCE(SUM(vl.violation_type IN ('Emission','Both')),0) AS emission_violations,
    COALESCE(SUM(vl.violation_type IN ('Noise','Both')),0) AS noise_violations,
    COALESCE(SUM(CASE WHEN vl.status='Pending' THEN vl.fine_amount END),0) AS pending_fines, MAX(vl.occurred_at) AS last_violation
FROM Vehicles v LEFT JOIN Violations_Log vl ON vl.vehicle_id = v.vehicle_id
GROUP BY v.vehicle_id, v.license_plate, v.owner_name, v.engine_type;
CREATE VIEW vw_zone_summary AS
SELECT COALESCE(z.zone_name,'Unzoned') AS zone_name, COALESCE(z.zone_type,'-') AS zone_type, z.max_noise_limit,
    COUNT(vl.violation_id) AS total_violations, SUM(vl.violation_type IN ('Noise','Both')) AS noise_violations,
    SUM(vl.violation_type IN ('Emission','Both')) AS emission_violations, ROUND(AVG(NULLIF(vl.noise_excess,0)),1) AS avg_noise_excess_db,
    SUM(vl.fine_amount) AS total_fines
FROM Violations_Log vl LEFT JOIN Zones z ON z.zone_id = vl.zone_id GROUP BY z.zone_id, z.zone_name, z.zone_type, z.max_noise_limit;

CREATE VIEW vw_sensor_health AS
SELECT s.sensor_id, s.mac_address, s.sensor_status, v.license_plate,
       MAX(t.recorded_at) AS last_reading, COUNT(t.log_id) AS total_readings
FROM IoT_Sensors s
JOIN Vehicles v            ON v.vehicle_id = s.vehicle_id
LEFT JOIN Telemetry_Logs t ON t.sensor_id  = s.sensor_id
GROUP BY s.sensor_id, s.mac_address, s.sensor_status, v.license_plate;


DELIMITER $$
CREATE PROCEDURE SeedDemoData(IN p_vehicles INT, IN p_readings INT)
BEGIN
    DECLARE i INT DEFAULT 1; DECLARE v_engine VARCHAR(10); DECLARE v_first VARCHAR(30); DECLARE v_last VARCHAR(30);
    DECLARE v_sensor INT; DECLARE v_j INT; DECLARE v_pick DOUBLE; DECLARE v_hot BOOLEAN;
    DECLARE v_co DOUBLE; DECLARE v_no2 DOUBLE; DECLARE v_noise DOUBLE; DECLARE v_lat DOUBLE; DECLARE v_lng DOUBLE;
    IF p_vehicles < 1 OR p_vehicles > 9999 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'p_vehicles must be between 1 and 9999';
    END IF;
    IF (SELECT COUNT(*) FROM Vehicles) > 0 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Seed only runs on an empty database';
    END IF;
    START TRANSACTION;
    WHILE i <= p_vehicles DO
        SET v_engine = ELT(1 + i % 3, 'Petrol', 'Diesel', 'CNG');
        SET v_first = ELT(1 + i % 10, 'Arjun','Priya','Rahul','Sneha','Vikram','Ananya','Karthik','Divya','Rohan','Meera');
        SET v_last = ELT(1 + (i DIV 10) % 8, 'Sharma','Iyer','Reddy','Nair','Patel','Gupta','Rao','Khan');
        INSERT INTO Vehicles VALUES (i, CONCAT('KA', LPAD(1 + i % 60, 2, '0'), CHAR(65 + i % 26), CHAR(65 + (i DIV 26) % 26), LPAD(i, 4, '0')),
             CONCAT(v_first, ' ', v_last), LOWER(CONCAT(v_first, '.', v_last, i, '@example.com')), v_engine,
             CURDATE() - INTERVAL (365 + FLOOR(RAND() * 3285)) DAY);
        INSERT INTO IoT_Sensors VALUES (i, i, CONCAT('02:1A:3F:', LPAD(HEX((i >> 16) & 255), 2, '0'), ':', LPAD(HEX((i >> 8) & 255), 2, '0'), ':', LPAD(HEX(i & 255), 2, '0')),
             CURDATE() - INTERVAL FLOOR(RAND() * 365) DAY, IF(i % 20 = 0, 'Faulty', 'Active'));
        SET i = i + 1;
    END WHILE;
    COMMIT;
    SET i = 1;
    START TRANSACTION;
    WHILE i <= p_readings DO
        SET v_sensor = 1 + FLOOR(RAND() * p_vehicles);
        SET v_engine = ELT(1 + v_sensor % 3, 'Petrol', 'Diesel', 'CNG');
        SET v_hot = FALSE; SET v_pick = RAND();
        IF v_pick < 0.25 THEN
            SET v_hot = TRUE; SET v_j = 1 + FLOOR(RAND() * 5);
            SET v_lat = ELT(v_j, 12.9177, 13.0358, 13.0076, 12.9767, 12.9569) + (RAND() - 0.5) * 0.0008;
            SET v_lng = ELT(v_j, 77.6238, 77.5970, 77.6950, 77.5713, 77.7011) + (RAND() - 0.5) * 0.0008;
        ELSEIF v_pick < 0.40 THEN
            SELECT min_lat + RAND() * (max_lat - min_lat), min_lng + RAND() * (max_lng - min_lng) INTO v_lat, v_lng FROM Zones ORDER BY RAND() LIMIT 1;
        ELSE
            SET v_lat = 12.9716 + (RAND() - 0.5) * 0.16; SET v_lng = 77.5946 + (RAND() - 0.5) * 0.16;
        END IF;
        SET v_co = CASE v_engine WHEN 'Petrol' THEN 120 + RAND() * 110 WHEN 'Diesel' THEN 60 + RAND() * 80 ELSE 30 + RAND() * 60 END;
        IF RAND() < 0.10 THEN SET v_co = v_co * (1.3 + RAND() * 0.7); END IF;
        SET v_no2 = CASE v_engine WHEN 'Petrol' THEN 15 + RAND() * 30 WHEN 'Diesel' THEN 50 + RAND() * 65 ELSE 8 + RAND() * 20 END;
        IF RAND() < 0.08 THEN SET v_no2 = v_no2 * (1.3 + RAND() * 0.6); END IF;
        SET v_noise = 60 + RAND() * 15 + IF(v_hot, 5, 0);
        IF RAND() < 0.10 THEN SET v_noise = v_noise + 10 + RAND() * 15; END IF;
        INSERT INTO Telemetry_Logs (sensor_id, co_level, no2_level, noise_level, latitude, longitude, recorded_at)
        VALUES (v_sensor, v_co, v_no2, LEAST(v_noise, 200), v_lat, v_lng, NOW() - INTERVAL FLOOR(RAND() * 2592000) SECOND);
        IF i % 5000 = 0 THEN COMMIT; START TRANSACTION; END IF;
        SET i = i + 1;
    END WHILE;
    COMMIT;
END$$
DELIMITER ;

-- Generate demo data (takes ~20-60 s). In MySQL Workbench, first raise
-- Edit > Preferences > SQL Editor > DBMS connection read timeout to 600.
CALL SeedDemoData(200, 50000);
ANALYZE TABLE Telemetry_Logs, Violations_Log;
